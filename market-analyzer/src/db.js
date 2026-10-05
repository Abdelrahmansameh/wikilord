// SQLite store (Node's built-in node:sqlite). WAL mode + batched transactions keep inserts cheap,
// and card stats are copied onto each auction row so analysis queries never need a join.
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { TAGS_VERSION, tagsFor } from './categories.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT,
  avatar_url TEXT,
  first_seen INTEGER,
  last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS users_name ON users(username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  title TEXT,
  url TEXT,
  lang TEXT,
  rarity TEXT,
  atk INTEGER,
  def INTEGER,
  q_score REAL,
  pageviews INTEGER,
  category TEXT,
  image_url TEXT,
  summary TEXT,
  is_shiny INTEGER,
  hide_image INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS cards_title ON cards(title COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS auctions (
  id TEXT PRIMARY KEY,
  card_id TEXT,
  seller_id TEXT,
  title TEXT,
  category TEXT,
  lang TEXT,
  rarity TEXT,
  atk INTEGER,
  def INTEGER,
  q_score REAL,
  pageviews INTEGER,
  is_shiny INTEGER,
  base_amount INTEGER,
  listing_base_amount INTEGER,
  base_repriced_at INTEGER,
  current_bid INTEGER,
  current_bidder_id TEXT,
  effective_bid INTEGER,
  created_at INTEGER,
  end_at INTEGER,
  settled_at INTEGER,
  status TEXT,
  winner_id TEXT,
  final_price INTEGER,
  bid_count INTEGER,
  bidder_count INTEGER,
  first_bid_at INTEGER,
  last_bid_at INTEGER,
  search_doc TEXT,
  first_seen INTEGER,
  last_seen INTEGER,
  detail_at INTEGER,
  detail_tries INTEGER NOT NULL DEFAULT 0,
  final INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS auctions_pending ON auctions(end_at) WHERE final = 0;
CREATE INDEX IF NOT EXISTS auctions_final_end ON auctions(final, end_at);
CREATE INDEX IF NOT EXISTS auctions_rarity_end ON auctions(rarity, end_at);
CREATE INDEX IF NOT EXISTS auctions_card ON auctions(card_id);
CREATE INDEX IF NOT EXISTS auctions_seller ON auctions(seller_id, end_at);
CREATE INDEX IF NOT EXISTS auctions_winner ON auctions(winner_id, end_at);
CREATE INDEX IF NOT EXISTS auctions_title ON auctions(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS auctions_category ON auctions(category);
CREATE INDEX IF NOT EXISTS auctions_first_seen ON auctions(first_seen);

CREATE TABLE IF NOT EXISTS ingest_conflicts (
  auction_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  expected TEXT NOT NULL,
  observed TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bids (
  id TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL,
  bidder_id TEXT,
  amount INTEGER,
  placed_at INTEGER
);
CREATE INDEX IF NOT EXISTS bids_auction ON bids(auction_id, placed_at, bidder_id);
CREATE INDEX IF NOT EXISTS bids_bidder ON bids(bidder_id, placed_at);

-- Listing-feed sightings by login. Historical rows before this table existed cannot be attributed.
CREATE TABLE IF NOT EXISTS auction_account_seen (
  auction_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (auction_id, slot)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS auction_account_seen_slot ON auction_account_seen(slot, first_seen);

-- Groupable tags per category string (see categories.js): kind = theme | country | word.
CREATE TABLE IF NOT EXISTS category_tags (
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  tag TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (category, kind, tag)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS category_tags_tag ON category_tags(kind, tag);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS raw (
  auction_id TEXT PRIMARY KEY,
  fetched_at INTEGER,
  body BLOB
);
`;

const ms = (s) => (s ? Date.parse(s) : null);
const int = (b) => (b == null ? null : b ? 1 : 0);
const n = (v) => (v === undefined ? null : v);

export class Store {
  constructor(file, { log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -65536;
      PRAGMA mmap_size = 536870912;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_size_limit = 67108864;
      PRAGMA analysis_limit = 1000;
    `);
    this.db.exec(SCHEMA);
    this.migrate();
    this.optimize(true);
    this.prepare();
  }

  /**
   * Bounded planner statistics. On a fresh connection the 0x10000 bit checks every table, including
   * indexes just created by a migration; ordinary optimize only considers tables used by this connection.
   */
  optimize(initial = false) {
    if (!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'`).get()) this.db.exec('ANALYZE');
    else this.db.exec(initial ? 'PRAGMA optimize = 0x10002' : 'PRAGMA optimize');
  }

  /** Columns added after the first release; each runs once on an existing database. */
  migrate() {
    if (!this.db.prepare(`SELECT 1 FROM meta WHERE key = 'account_tracking_started_ms'`).get())
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('account_tracking_started_ms', ?)`).run(String(Date.now()));
    const auctionCols = new Set(this.db.prepare('PRAGMA table_info(auctions)').all().map((c) => c.name));
    if (!auctionCols.has('first_source')) this.db.exec('ALTER TABLE auctions ADD COLUMN first_source TEXT');
    if (!auctionCols.has('seen_recent_at')) this.db.exec('ALTER TABLE auctions ADD COLUMN seen_recent_at INTEGER');
    if (!auctionCols.has('seen_ending_at')) this.db.exec('ALTER TABLE auctions ADD COLUMN seen_ending_at INTEGER');
    const bidIndexCols = this.db.prepare('PRAGMA index_info(bids_auction)').all().map((column) => column.name);
    if (bidIndexCols.join(',') !== 'auction_id,placed_at,bidder_id') {
      const started = Date.now();
      this.log('database: upgrading bid lookup index for player statistics (one-time migration)');
      // Replace the old index atomically: player totals can read bidder IDs without random bid-table
      // fetches, and failed builds retain the previous index. Its ordering still covers bid timing.
      this.tx(() => this.db.exec(`DROP INDEX bids_auction;
        CREATE INDEX bids_auction ON bids(auction_id, placed_at, bidder_id)`));
      this.log(`database: bid lookup index ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    const cols = new Set(this.db.prepare('PRAGMA table_info(cards)').all().map((c) => c.name));
    if (!cols.has('times_sold')) {
      // How often each card has changed hands / been put up, over everything recorded (kept up to date in saveResult).
      this.db.exec(`
        ALTER TABLE cards ADD COLUMN times_sold INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE cards ADD COLUMN times_listed INTEGER NOT NULL DEFAULT 0;
        UPDATE cards SET
          times_sold = (SELECT COUNT(*) FROM auctions a WHERE a.card_id = cards.id AND a.final = 1 AND a.status = 'settled_sold'),
          times_listed = (SELECT COUNT(*) FROM auctions a WHERE a.card_id = cards.id AND a.final = 1 AND a.status LIKE 'settled%');
        CREATE INDEX IF NOT EXISTS cards_times_sold ON cards(times_sold);
      `);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS cards_times_listed ON cards(times_listed)');
    // The Cards tab's default "most traded" list, without sorting every card.
    this.db.exec('CREATE INDEX IF NOT EXISTS cards_traded ON cards(times_sold DESC, times_listed DESC, title)');
    this.db.exec(`CREATE INDEX IF NOT EXISTS auctions_sold_card_price ON auctions(card_id, final_price)
      WHERE final = 1 AND status = 'settled_sold' AND final_price IS NOT NULL`);
    this.db.exec('CREATE INDEX IF NOT EXISTS auctions_card_seen ON auctions(card_id, first_seen, rarity, is_shiny)');
    // Read the small analytic fields in end-time order without fetching millions of wide auction rows.
    // Keeping final as the first key also avoids a bad plan when bounded ANALYZE underestimates the
    // cardinality of final=1 on auctions_final_end. The partial predicate must match analysis.where().
    if (!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'auctions_dashboard'`).get()) {
      const started = Date.now();
      this.log('database: building dashboard index (one-time migration; large databases can take a few minutes)');
      this.db.exec(`CREATE INDEX auctions_dashboard ON auctions(
        final, end_at, rarity, is_shiny, status, final_price, base_amount, bid_count, bidder_count,
        seller_id, winner_id, card_id, q_score, id, created_at, last_bid_at, category, pageviews, atk, def
      ) WHERE final = 1 AND status IN ('settled_sold', 'settled_unsold')`);
      this.log(`database: dashboard index ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    if (!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'auctions_feed_seen'`).get()) {
      const started = Date.now();
      this.log('database: building feed diagnostics index (one-time migration)');
      this.db.exec('CREATE INDEX auctions_feed_seen ON auctions(seen_recent_at, seen_ending_at)');
      this.log(`database: feed diagnostics index ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    // (Re)tag every category when the tagging rules changed (or on first run).
    const v = this.db.prepare(`SELECT value FROM meta WHERE key = 'tags_version'`).get()?.value;
    if (v !== String(TAGS_VERSION)) {
      const ins = this.db.prepare(`INSERT OR IGNORE INTO category_tags (category, kind, tag, label) VALUES (?, ?, ?, ?)`);
      this.tx(() => {
        this.db.exec('DELETE FROM category_tags');
        for (const { category } of this.db.prepare('SELECT DISTINCT category FROM auctions WHERE category IS NOT NULL').all())
          for (const t of tagsFor(category)) ins.run(category, t.kind, t.tag, t.label);
        this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('tags_version', ?)`).run(String(TAGS_VERSION));
      });
    }
  }

  /** Tag a category the first time it shows up in a stored result. */
  _tagCategory(category) {
    if (!category || this.s.hasTags.get({ category })) return;
    for (const t of tagsFor(category)) this.s.tag.run({ category, kind: t.kind, tag: t.tag, label: t.label });
  }

  prepare() {
    const d = this.db;
    this.s = {
      user: d.prepare(`
        INSERT INTO users (id, username, avatar_url, first_seen, last_seen) VALUES ($id, $username, $avatar_url, $now, $now)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username, avatar_url = excluded.avatar_url, last_seen = excluded.last_seen`),
      card: d.prepare(`
        INSERT INTO cards (id, title, url, lang, rarity, atk, def, q_score, pageviews, category, image_url, summary, is_shiny, hide_image, created_at, updated_at)
        VALUES ($id, $title, $url, $lang, $rarity, $atk, $def, $q_score, $pageviews, $category, $image_url, $summary, $is_shiny, $hide_image, $created_at, $now)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url, lang = excluded.lang, rarity = excluded.rarity,
          atk = excluded.atk, def = excluded.def, q_score = excluded.q_score, pageviews = excluded.pageviews, category = excluded.category,
          image_url = excluded.image_url, summary = COALESCE(excluded.summary, cards.summary), is_shiny = excluded.is_shiny,
          hide_image = excluded.hide_image, updated_at = excluded.updated_at`),
      // A list snapshot never overwrites an auction whose final result is already stored.
      snapshot: d.prepare(`
        INSERT INTO auctions (id, card_id, seller_id, title, category, lang, rarity, atk, def, q_score, pageviews, is_shiny,
          base_amount, listing_base_amount, base_repriced_at, current_bid, current_bidder_id, effective_bid, created_at, end_at,
          status, search_doc, first_seen, last_seen, first_source, seen_recent_at, seen_ending_at)
        VALUES ($id, $card_id, $seller_id, $title, $category, $lang, $rarity, $atk, $def, $q_score, $pageviews, $is_shiny,
          $base_amount, $listing_base_amount, $base_repriced_at, $current_bid, $current_bidder_id, $effective_bid, $created_at, $end_at,
          $status, $search_doc, $now, $now, $source, $seen_recent_at, $seen_ending_at)
        ON CONFLICT(id) DO UPDATE SET
          base_amount = CASE WHEN auctions.final = 0 THEN excluded.base_amount ELSE auctions.base_amount END,
          listing_base_amount = CASE WHEN auctions.final = 0 THEN excluded.listing_base_amount ELSE auctions.listing_base_amount END,
          base_repriced_at = CASE WHEN auctions.final = 0 THEN excluded.base_repriced_at ELSE auctions.base_repriced_at END,
          current_bid = CASE WHEN auctions.final = 0 THEN excluded.current_bid ELSE auctions.current_bid END,
          current_bidder_id = CASE WHEN auctions.final = 0 THEN excluded.current_bidder_id ELSE auctions.current_bidder_id END,
          effective_bid = CASE WHEN auctions.final = 0 THEN excluded.effective_bid ELSE auctions.effective_bid END,
          end_at = CASE WHEN auctions.final = 0 THEN excluded.end_at ELSE auctions.end_at END,
          status = CASE WHEN auctions.final = 0 THEN excluded.status ELSE auctions.status END,
          pageviews = CASE WHEN auctions.final = 0 THEN excluded.pageviews ELSE auctions.pageviews END,
          q_score = CASE WHEN auctions.final = 0 THEN excluded.q_score ELSE auctions.q_score END,
          last_seen = excluded.last_seen,
          seen_recent_at = COALESCE(excluded.seen_recent_at, auctions.seen_recent_at),
          seen_ending_at = COALESCE(excluded.seen_ending_at, auctions.seen_ending_at)`),
      settle: d.prepare(`
        INSERT INTO auctions (id, card_id, seller_id, title, category, lang, rarity, atk, def, q_score, pageviews, is_shiny,
          base_amount, listing_base_amount, base_repriced_at, current_bid, current_bidder_id, effective_bid, created_at, end_at,
          settled_at, status, winner_id, final_price, bid_count, bidder_count, first_bid_at, last_bid_at, search_doc,
          first_seen, last_seen, detail_at, detail_tries, final)
        VALUES ($id, $card_id, $seller_id, $title, $category, $lang, $rarity, $atk, $def, $q_score, $pageviews, $is_shiny,
          $base_amount, $listing_base_amount, $base_repriced_at, $current_bid, $current_bidder_id, $effective_bid, $created_at, $end_at,
          $settled_at, $status, $winner_id, $final_price, $bid_count, $bidder_count, $first_bid_at, $last_bid_at, $search_doc,
          $now, $now, $now, 1, 1)
        ON CONFLICT(id) DO UPDATE SET card_id = excluded.card_id, seller_id = excluded.seller_id, title = excluded.title,
          category = excluded.category, lang = excluded.lang, rarity = excluded.rarity, atk = excluded.atk, def = excluded.def,
          q_score = excluded.q_score, pageviews = excluded.pageviews, is_shiny = excluded.is_shiny, base_amount = excluded.base_amount,
          listing_base_amount = excluded.listing_base_amount, base_repriced_at = excluded.base_repriced_at,
          current_bid = excluded.current_bid, current_bidder_id = excluded.current_bidder_id, effective_bid = excluded.effective_bid,
          created_at = excluded.created_at, end_at = excluded.end_at, settled_at = excluded.settled_at, status = excluded.status,
          winner_id = excluded.winner_id, final_price = excluded.final_price, bid_count = excluded.bid_count,
          bidder_count = excluded.bidder_count, first_bid_at = excluded.first_bid_at, last_bid_at = excluded.last_bid_at,
          search_doc = excluded.search_doc, last_seen = excluded.last_seen, detail_at = excluded.detail_at,
          detail_tries = auctions.detail_tries + 1, final = 1
        WHERE auctions.final = 0 OR auctions.status NOT IN ('settled_sold', 'settled_unsold', 'cancelled')`),
      bid: d.prepare(`INSERT OR IGNORE INTO bids (id, auction_id, bidder_id, amount, placed_at) VALUES ($id, $auction_id, $bidder_id, $amount, $placed_at)`),
      accountSeen: d.prepare(`INSERT INTO auction_account_seen (auction_id, slot, first_seen, last_seen)
        VALUES ($id, $slot, $now, $now)
        ON CONFLICT(auction_id, slot) DO UPDATE SET last_seen = excluded.last_seen`),
      // Recounted rather than incremented, so storing the same result twice can never inflate it.
      cardCounts: d.prepare(`
        UPDATE cards SET
          times_sold = (SELECT COUNT(*) FROM auctions a WHERE a.card_id = $id AND a.final = 1 AND a.status = 'settled_sold'),
          times_listed = (SELECT COUNT(*) FROM auctions a WHERE a.card_id = $id AND a.final = 1 AND a.status LIKE 'settled%')
        WHERE id = $id`),
      hasTags: d.prepare(`SELECT 1 FROM category_tags WHERE category = $category LIMIT 1`),
      tag: d.prepare(`INSERT OR IGNORE INTO category_tags (category, kind, tag, label) VALUES ($category, $kind, $tag, $label)`),
      raw: d.prepare(`INSERT OR REPLACE INTO raw (auction_id, fetched_at, body) VALUES ($id, $now, $body)`),
      tried: d.prepare(`UPDATE auctions SET detail_tries = detail_tries + 1, detail_at = $now, end_at = COALESCE($end_at, end_at) WHERE id = $id`),
      pending: d.prepare(`SELECT id, end_at, detail_tries FROM auctions WHERE final = 0 AND end_at <= $cutoff ORDER BY end_at`),
      auctionIdentity: d.prepare(`SELECT card_id, seller_id, created_at, final, status, final_price, winner_id FROM auctions WHERE id = ?`),
      conflict: d.prepare(`INSERT INTO ingest_conflicts (auction_id, kind, source, expected, observed, first_at, last_at)
        VALUES ($auction_id, $kind, $source, $expected, $observed, $now, $now)
        ON CONFLICT(auction_id) DO UPDATE SET last_at = excluded.last_at, occurrences = occurrences + 1,
          kind = excluded.kind, source = excluded.source, observed = excluded.observed`),
      metaGet: d.prepare(`SELECT value FROM meta WHERE key = ?`),
      metaSet: d.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    };
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  _user(u, now) {
    if (u?.id) this.s.user.run({ id: u.id, username: n(u.username), avatar_url: n(u.avatar_url), now });
  }

  _card(c, now) {
    if (!c?.id) return;
    this.s.card.run({
      id: c.id,
      title: n(c.wikipedia_title),
      url: n(c.wikipedia_url),
      lang: n(c.lang),
      rarity: n(c.rarity),
      atk: n(c.atk),
      def: n(c.def),
      q_score: n(c.q_score),
      pageviews: n(c.pageviews),
      category: n(c.category),
      image_url: n(c.image_url),
      summary: n(c.summary),
      is_shiny: int(c.is_shiny),
      hide_image: int(c.hide_image),
      created_at: ms(c.created_at),
      now,
    });
  }

  /** Fields shared by list snapshots and settled results. Rarity/ATK/DEF use the listing-time snapshot. */
  _auctionRow(a, now) {
    const c = a.card ?? {};
    return {
      id: a.id,
      card_id: n(a.card_id),
      seller_id: n(a.seller_id),
      title: n(c.wikipedia_title),
      category: n(c.category),
      lang: n(c.lang),
      rarity: n(a.snapshot_rarity ?? c.rarity),
      atk: n(a.snapshot_atk ?? c.atk),
      def: n(a.snapshot_def ?? c.def),
      q_score: n(c.q_score),
      pageviews: n(c.pageviews),
      is_shiny: int(a.is_shiny ?? c.is_shiny),
      base_amount: n(a.base_amount),
      listing_base_amount: n(a.listing_base_amount),
      base_repriced_at: ms(a.base_repriced_at),
      current_bid: n(a.current_bid),
      current_bidder_id: n(a.current_bidder_id),
      effective_bid: n(a.effective_bid),
      created_at: ms(a.created_at),
      end_at: ms(a.end_at),
      status: n(a.status),
      search_doc: n(a.snapshot_search_document),
      now,
    };
  }

  _identityMismatch(existing, row) {
    return ['card_id', 'seller_id', 'created_at'].some((key) => existing[key] != null && row[key] != null && existing[key] !== row[key]);
  }

  _conflict(id, kind, source, expected, observed, now) {
    this.s.conflict.run({ auction_id: id, kind, source, expected: JSON.stringify(expected), observed: JSON.stringify(observed), now });
  }

  /** One transaction per list page. The global auction ID is the only record key across accounts and feeds. */
  saveSnapshots(list, source = 'ending', account = null) {
    if (source !== 'ending' && source !== 'recent') throw new Error('unknown listing source');
    const now = Date.now();
    return this.tx(() => {
      const result = { fresh: 0, pending: [], conflicts: 0, seen: 0 };
      for (const a of list) {
        if (!a?.id) continue;
        const row = this._auctionRow(a, now);
        const existing = this.s.auctionIdentity.get(a.id);
        if (existing && this._identityMismatch(existing, row)) {
          this._conflict(a.id, 'identity', source, existing, row, now);
          result.conflicts++;
          continue;
        }
        result.seen++;
        if (!existing) result.fresh++;
        this._user(a.seller, now);
        this._user(a.current_bidder, now);
        this._card(a.card, now);
        this._tagCategory(a.card?.category);
        this.s.snapshot.run({ ...row, source, seen_recent_at: source === 'recent' ? now : null,
          seen_ending_at: source === 'ending' ? now : null });
        if (account) this.s.accountSeen.run({ id: a.id, slot: account, now });
        if (!existing || !existing.final) result.pending.push({ id: a.id, end_at: row.end_at, status: a.status });
      }
      return result;
    });
  }

  /** Store a terminal auction from its detail endpoint: final result and every bid. */
  saveResult(detail, keepRaw, source = 'primary') {
    const a = detail.auction;
    if (!a?.id || !['settled_sold', 'settled_unsold', 'cancelled'].includes(a.status))
      throw new Error(`detail is not a terminal auction (${a?.status ?? 'missing'})`);
    const bids = detail.bids ?? [];
    const now = Date.now();
    const times = bids.map((b) => ms(b.placed_at)).filter((t) => t != null);
    let body = null;
    if (keepRaw) {
      // The card summary is kept once in `cards`; no need to store it again per auction.
      const slim = a.card?.summary ? { ...detail, auction: { ...a, card: { ...a.card, summary: undefined } } } : detail;
      body = zlib.brotliCompressSync(Buffer.from(JSON.stringify(slim)), {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
      });
    }
    return this.tx(() => {
      const row = this._auctionRow(a, now);
      const existing = this.s.auctionIdentity.get(a.id);
      if (existing && this._identityMismatch(existing, row)) {
        this._conflict(a.id, 'identity', source, existing, row, now);
        return { stored: false, conflict: true };
      }
      if (existing?.final && ['settled_sold', 'settled_unsold', 'cancelled'].includes(existing.status)) {
        const same = existing.status === a.status && existing.final_price === n(a.final_price) && existing.winner_id === n(a.winner_id);
        if (!same) this._conflict(a.id, 'result', source, existing,
          { status: a.status, final_price: n(a.final_price), winner_id: n(a.winner_id) }, now);
        return { stored: false, duplicate: same, conflict: !same, retry: false };
      }
      this._user(a.seller, now);
      this._user(a.current_bidder, now);
      this._user(a.winner, now);
      for (const b of bids) this._user(b.bidder, now);
      this._card(a.card, now);
      this.s.settle.run({
        ...row,
        settled_at: ms(a.settled_at),
        winner_id: n(a.winner_id),
        final_price: n(a.final_price),
        bid_count: bids.length,
        bidder_count: new Set(bids.map((b) => b.bidder_id)).size,
        first_bid_at: times.length ? Math.min(...times) : null,
        last_bid_at: times.length ? Math.max(...times) : null,
      });
      for (const b of bids)
        this.s.bid.run({ id: b.id, auction_id: a.id, bidder_id: n(b.bidder_id), amount: n(b.amount), placed_at: ms(b.placed_at) });
      if (a.card_id) this.s.cardCounts.run({ id: a.card_id });
      this._tagCategory(a.card?.category);
      if (body) this.s.raw.run({ id: a.id, now, body });
      return { stored: true };
    });
  }

  markTried(id, endAt = null) {
    this.s.tried.run({ id, now: Date.now(), end_at: endAt });
  }

  pending(cutoff = Date.now()) {
    return this.s.pending.all({ cutoff });
  }

  getMeta(key) {
    return this.s.metaGet.get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.s.metaSet.run(key, String(value));
  }

  setRecentProgress(watermark, cursor, head, prefix = '') {
    this.tx(() => {
      this.s.metaSet.run(`${prefix}recent_watermark_ms`, String(watermark));
      this.s.metaSet.run(`${prefix}recent_cursor`, JSON.stringify(cursor));
      this.s.metaSet.run(`${prefix}recent_head_ms`, String(head));
    });
  }

  ingestionInfo(cacheMs = 0) {
    const now = Date.now();
    if (!cacheMs || !this._accountInfoCache || now - this._accountInfoCache.at >= cacheMs) {
      const feeds = this.db.prepare(`SELECT
        COALESCE(SUM(seen_recent_at IS NOT NULL), 0) recent_seen,
        COALESCE(SUM(seen_ending_at IS NOT NULL), 0) ending_seen,
        COALESCE(SUM(seen_recent_at IS NOT NULL AND seen_ending_at IS NOT NULL), 0) overlap,
        (SELECT COUNT(*) FROM ingest_conflicts) conflicts FROM auctions`).get();
      const scoutStart = Number(this.db.prepare(`SELECT value FROM meta WHERE key = 'scout_mode_started_ms'`).get()?.value);
      // Stream sightings in primary-key order once. The join predicates skip auction metadata seeks for
      // overlapping accounts and old sightings before looking up the few exclusive scout candidates.
      const historical = this.db.prepare(`SELECT
        COUNT(*) tracked,
        SUM((mask & 1) != 0) primary_seen,
        SUM((mask & 2) != 0) secondary_seen,
        SUM((mask & 4) != 0) tertiary_seen,
        SUM(mask = 1) primary_only,
        SUM(mask = 2) secondary_only,
        SUM(mask = 4) tertiary_only,
        NULL tertiary_only_final,
        SUM((mask & 4) != 0 AND (mask & 3) != 0) tertiary_overlap,
        ${scoutStart ? `COALESCE(SUM(a.id IS NOT NULL), 0) scout_only,
          COALESCE(SUM(a.id IS NOT NULL AND a.final = 1), 0) scout_only_final` :
          'NULL scout_only, NULL scout_only_final'}
        FROM (
          SELECT auction_id,
            SUM(CASE slot WHEN 'primary' THEN 1 WHEN 'secondary' THEN 2 WHEN 'tertiary' THEN 4 ELSE 0 END) mask,
            MIN(CASE WHEN slot = 'tertiary' THEN first_seen END) tertiary_first
          FROM auction_account_seen GROUP BY auction_id
        ) g ${scoutStart ? `LEFT JOIN auctions a ON a.id = CASE
          WHEN g.mask = 4 AND g.tertiary_first >= ? THEN g.auction_id END
          AND a.first_seen >= ?` : ''}`).get(...(scoutStart ? [scoutStart, scoutStart] : []));
      const scoutTracked = scoutStart ? this.db.prepare('SELECT COUNT(*) n FROM auctions WHERE first_seen >= ?').get(scoutStart).n : null;
      this._accountInfoCache = { at: now, value: { ...feeds, accounts: { ...historical, scout_tracked: scoutTracked } } };
    }
    return this._accountInfoCache.value;
  }

  /** Decompressed raw JSON for one auction, or null. */
  raw(id) {
    const r = this.db.prepare('SELECT body FROM raw WHERE auction_id = ?').get(id);
    return r ? JSON.parse(zlib.brotliDecompressSync(r.body).toString('utf8')) : null;
  }
}
