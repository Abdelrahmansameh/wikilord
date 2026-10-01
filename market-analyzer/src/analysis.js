// Read-only queries behind the dashboard. Every endpoint takes the same filters:
//   range = 1h | 24h | 7d | 30d | all   rarity = C,R,...   shiny = 0 | 1   tz = minutes (Date#getTimezoneOffset)

const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
const BUCKET = { '1h': 60e3, '6h': 5 * 60e3, '24h': 15 * 60e3, '7d': 3600e3, '30d': 6 * 3600e3, all: 86400e3 };
export const RARITY_ORDER = ['C', 'PC', 'R', 'SR', 'UR', 'L'];
const rarityRank = (r) => {
  const i = RARITY_ORDER.indexOf(r);
  return i < 0 ? 99 : i;
};

/** WHERE clause for settled auctions matching the filters. `a` = table alias prefix. */
function where(q, a = '', mode = 'settled') {
  const active = mode === 'active';
  const cancelled = mode === 'cancelled';
  const parts = active ? [`${a}final = 0`, `${a}status = 'active'`] : cancelled ?
    [`${a}final = 1`, `${a}status = 'cancelled'`] : [`${a}final = 1`, `${a}status LIKE 'settled%'`];
  const params = {};
  if (RANGES[q.range]) {
    parts.push(`${a}${active ? 'created_at' : 'end_at'} >= $since`);
    params.since = Date.now() - RANGES[q.range];
  }
  if (q.rarity) {
    const list = String(q.rarity).split(',').filter(Boolean);
    list.forEach((r, i) => (params['r' + i] = r));
    parts.push(`${a}rarity IN (${list.map((_, i) => '$r' + i).join(',')})`);
  }
  if (q.shiny === '0' || q.shiny === '1') {
    parts.push(`${a}is_shiny = $shiny`);
    params.shiny = Number(q.shiny);
  }
  return { sql: parts.join(' AND '), params };
}

export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)) * 10) / 10;
}

function spread(sorted) {
  return {
    min: sorted[0] ?? null,
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    max: sorted.at(-1) ?? null,
  };
}

const LOG_EDGES = [1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 50000, Infinity];

function histogram(values, edges = LOG_EDGES) {
  const counts = new Array(edges.length).fill(0);
  for (const v of values) {
    let i = 0;
    while (v >= edges[i]) i++;
    counts[i]++;
  }
  return edges.map((e, i) => ({ lt: e === Infinity ? null : e, n: counts[i] }));
}

export class Analysis {
  constructor(store) {
    this.db = store.db;
    this.store = store;
    this.cache = new Map();
  }

  /** Small TTL cache so a dashboard refresh doesn't rescan millions of rows every few seconds. */
  cached(key, ttlMs, fn) {
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = fn();
    this.cache.set(key, { value, until: Date.now() + ttlMs });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  all(sql, params = {}) {
    return this.db.prepare(sql).all(params);
  }

  get(sql, params = {}) {
    return this.db.prepare(sql).get(params);
  }

  dbInfo() {
    return this.cached('dbinfo', 10_000, () => {
      const c = this.get(`SELECT COUNT(*) total, SUM(final = 1) settled, SUM(final = 0) open FROM auctions`);
      const pages = this.get(`PRAGMA page_count`).page_count;
      const size = this.get(`PRAGMA page_size`).page_size;
      return {
        auctions: c.total,
        settled: c.settled ?? 0,
        open: c.open ?? 0,
        bids: this.get(`SELECT COUNT(*) n FROM bids`).n,
        users: this.get(`SELECT COUNT(*) n FROM users`).n,
        cards: this.get(`SELECT COUNT(*) n FROM cards`).n,
        bytes: pages * size,
        oldest: this.get(`SELECT MIN(end_at) t FROM auctions WHERE final = 1`).t,
      };
    });
  }

  overview(q) {
    return this.cached('overview' + JSON.stringify(q), 5000, () => {
      const w = where(q);
      const totals = this.get(
        `SELECT COUNT(*) n, SUM(status = 'settled_sold') sold,
           SUM(CASE WHEN status = 'settled_sold' THEN final_price END) volume,
           SUM(bid_count) bids, COUNT(DISTINCT winner_id) buyers, COUNT(DISTINCT seller_id) sellers,
           AVG(CASE WHEN status = 'settled_sold' AND base_amount > 0 THEN 1.0 * final_price / base_amount END) markup
         FROM auctions WHERE ${w.sql}`,
        w.params,
      );
      const step = BUCKET[q.range] ?? BUCKET.all;
      const series = this.all(
        `SELECT (end_at / ${step}) * ${step} t, COUNT(*) n, SUM(status = 'settled_sold') sold,
           SUM(CASE WHEN status = 'settled_sold' THEN final_price ELSE 0 END) volume
         FROM auctions WHERE ${w.sql} GROUP BY 1 ORDER BY 1`,
        w.params,
      );
      return { totals, series, step };
    });
  }

  /** How many times each recorded card sold (0 = auctioned but never sold), as a count of cards per number of sales. */
  turnover(q) {
    return this.cached('turnover' + JSON.stringify(q), 30_000, () => {
      const w = where(q);
      const rows = this.all(
        `SELECT sold, COUNT(*) cards FROM (
           SELECT card_id, SUM(status = 'settled_sold') sold FROM auctions WHERE ${w.sql} AND card_id IS NOT NULL GROUP BY card_id
         ) GROUP BY sold ORDER BY sold`,
        w.params,
      );
      return { total: rows.reduce((s, r) => s + r.cards, 0), rows };
    });
  }

  /** Per rarity (and shiny): sell-through, price spread, bids, markup over the starting price. */
  prices(q) {
    return this.cached('prices' + JSON.stringify(q), 15_000, () => {
      const w = where(q);
      const groups = this.all(
        `SELECT rarity, is_shiny, COUNT(*) n, SUM(status = 'settled_sold') sold,
           AVG(base_amount) avg_base, AVG(bid_count) avg_bids, AVG(bidder_count) avg_bidders,
           AVG(CASE WHEN status = 'settled_sold' THEN final_price END) avg_price,
           SUM(CASE WHEN status = 'settled_sold' THEN final_price END) volume,
           AVG(CASE WHEN status = 'settled_sold' AND base_amount > 0 THEN 1.0 * final_price / base_amount END) markup,
           SUM(status = 'settled_sold' AND bid_count = 1) single_bid
         FROM auctions WHERE ${w.sql} GROUP BY rarity, is_shiny`,
        w.params,
      );
      const prices = new Map();
      for (const r of this.db
        .prepare(`SELECT rarity, is_shiny, final_price p FROM auctions WHERE ${w.sql} AND status = 'settled_sold' ORDER BY final_price`)
        .iterate(w.params)) {
        const k = r.rarity + '|' + r.is_shiny;
        if (!prices.has(k)) prices.set(k, []);
        prices.get(k).push(r.p);
      }
      for (const g of groups) {
        const s = prices.get(g.rarity + '|' + g.is_shiny) ?? [];
        Object.assign(g, spread(s), { histogram: histogram(s) });
      }
      groups.sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) || a.is_shiny - b.is_shiny);
      return groups;
    });
  }

  /** Starting price vs sell-through and final price, per rarity. */
  startingPrice(q) {
    return this.cached('start' + JSON.stringify(q), 15_000, () => {
      const w = where(q);
      const edges = [1, 5, 10, 20, 50, 100, 200, 500, 1000, 5000];
      const bucket = `CASE ${edges.map((e) => `WHEN base_amount < ${e} THEN ${e}`).join(' ')} ELSE 0 END`;
      const rows = this.all(
        `SELECT rarity, ${bucket} lt, COUNT(*) n, SUM(status = 'settled_sold') sold,
           AVG(CASE WHEN status = 'settled_sold' THEN final_price END) avg_price, AVG(bid_count) avg_bids
         FROM auctions WHERE ${w.sql} GROUP BY 1, 2`,
        w.params,
      );
      rows.sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) || (a.lt || 1e9) - (b.lt || 1e9));
      return { edges, rows };
    });
  }

  /** Price against a card stat, for one rarity: a sample of sold auctions. */
  scatter(q) {
    const x = { q_score: 'q_score', atk: 'atk', def: 'def', power: 'atk + def', pageviews: 'pageviews', base: 'base_amount' }[q.x] ?? 'q_score';
    return this.cached('scatter' + JSON.stringify(q), 15_000, () => {
      const w = where(q);
      return this.all(
        `SELECT ${x} x, final_price y, rarity, title FROM auctions
         WHERE ${w.sql} AND status = 'settled_sold' AND ${x} IS NOT NULL ORDER BY end_at DESC LIMIT 4000`,
        w.params,
      );
    });
  }

  /**
   * How auctions are grouped on the Categories tab. mode = theme | country | word (via category_tags) | exact (raw text).
   * Returns SQL pieces that put the group key in column `g`.
   */
  _group(mode) {
    if (mode === 'exact') return { join: '', key: 'a.category', label: 'a.category', extra: ' AND a.category IS NOT NULL', params: {} };
    const kind = { theme: 'theme', country: 'country', word: 'word' }[mode] ?? 'theme';
    return { join: 'CROSS JOIN category_tags t ON t.category = a.category AND t.kind = $kind', key: 't.tag', label: 'MIN(t.label)', extra: '', params: { kind } };
  }

  /** Typical (median) sale price per rarity+shiny in this range, as a SQL VALUES table for the price index. */
  _rarityMedians(q) {
    const rows = this.prices({ range: q.range, rarity: q.rarity, shiny: q.shiny }).filter((g) => g.median > 0);
    if (!rows.length) return `rmed(rarity, shiny, med) AS (SELECT NULL, NULL, NULL WHERE 0)`;
    const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
    return `rmed(rarity, shiny, med) AS (VALUES ${rows.map((g) => `(${esc(g.rarity)}, ${g.is_shiny}, ${g.median})`).join(', ')})`;
  }

  /** Split only the observed portion of a range, so a new database still has meaningful trends. */
  _rangeStart(q) {
    return Math.max(Date.now() - (RANGES[q.range] ?? Infinity), this.dbInfo().oldest ?? Date.now());
  }

  /** One row per category group with every metric the Categories tab can sort by. */
  categoryGroups(q) {
    return this.cached('catgroups' + JSON.stringify(q), 60_000, () => {
      const G = this._group(q.mode);
      const w = where(q, 'a.');
      const min = Math.max(1, Number(q.min) || 1);
      const mid = Math.round((this._rangeStart(q) + Date.now()) / 2);
      const params = { ...w.params, ...G.params };
      const from = `FROM auctions a ${G.join} WHERE ${w.sql}${G.extra}`;
      const SOLD = `a.status = 'settled_sold'`;
      const LOGIDX = `LN(a.final_price * 1.0 / m.med)`;
      const rows = this.all(
        `WITH ${this._rarityMedians(q)}
         SELECT ${G.key} g, ${G.label} label, COUNT(*) n, COUNT(DISTINCT a.card_id) cards, SUM(${SOLD}) sold,
           SUM(CASE WHEN ${SOLD} THEN a.final_price END) volume,
           AVG(CASE WHEN ${SOLD} THEN a.final_price END) avg_price,
           MAX(CASE WHEN ${SOLD} THEN a.final_price END) max_price,
           AVG(CASE WHEN ${SOLD} AND a.base_amount > 0 THEN 1.0 * a.final_price / a.base_amount END) markup,
           AVG(a.bid_count) avg_bids, AVG(a.bidder_count) avg_bidders,
           AVG(CASE WHEN ${SOLD} THEN a.bid_count = 1 END) one_bid,
           AVG(CASE WHEN ${SOLD} THEN a.end_at - a.last_bid_at < 60000 END) snipe,
           AVG(a.base_amount) avg_start, AVG(a.q_score) avg_q, AVG(a.pageviews) avg_pv,
           AVG(a.rarity IN ('UR', 'L')) high_share,
           EXP(AVG(CASE WHEN ${SOLD} AND a.final_price > 0 AND m.med > 0 THEN ${LOGIDX} END)) price_index,
           SUM(a.end_at < ${mid}) n1, SUM(a.end_at >= ${mid}) n2,
           SUM(${SOLD} AND a.end_at < ${mid}) s1, SUM(${SOLD} AND a.end_at >= ${mid}) s2,
           EXP(AVG(CASE WHEN ${SOLD} AND a.end_at < ${mid} AND a.final_price > 0 AND m.med > 0 THEN ${LOGIDX} END)) idx1,
           EXP(AVG(CASE WHEN ${SOLD} AND a.end_at >= ${mid} AND a.final_price > 0 AND m.med > 0 THEN ${LOGIDX} END)) idx2
         FROM auctions a ${G.join} LEFT JOIN rmed m ON m.rarity = a.rarity AND m.shiny = a.is_shiny
         WHERE ${w.sql}${G.extra}
         GROUP BY 1 HAVING COUNT(*) >= ${min}`,
        params,
      );
      const byG = new Map(rows.map((r) => [r.g, r]));
      // Median sale price per group (window functions keep this in SQL).
      for (const r of this.all(
        `WITH s AS (SELECT ${G.key} g, a.final_price p ${from} AND ${SOLD}),
              o AS (SELECT g, p, ROW_NUMBER() OVER (PARTITION BY g ORDER BY p) rn, COUNT(*) OVER (PARTITION BY g) c FROM s)
         SELECT g, AVG(p) median FROM o WHERE rn IN ((c + 1) / 2, (c + 2) / 2) GROUP BY g`,
        params,
      ))
        if (byG.has(r.g)) byG.get(r.g).median = r.median;
      // Of the cards that sold, how many sold again within the range (flipping).
      for (const r of this.all(
        `SELECT g, AVG(k >= 2) resold FROM (SELECT ${G.key} g, a.card_id, SUM(${SOLD}) k ${from} GROUP BY 1, 2) WHERE k >= 1 GROUP BY g`,
        params,
      ))
        if (byG.has(r.g)) byG.get(r.g).resold = r.resold;
      // Rarity mix, for the little stacked bar.
      for (const r of this.all(`SELECT ${G.key} g, a.rarity r, COUNT(*) n ${from} GROUP BY 1, 2`, params)) {
        const row = byG.get(r.g);
        if (row) (row.mix ??= {})[r.r] = r.n;
      }
      for (const r of rows) {
        r.sell_through = r.n ? r.sold / r.n : null;
        // Trends compare the second half of the range with the first; only shown with enough data on both sides.
        r.activity_trend = r.n1 >= 5 && r.n2 >= 5 ? r.n2 / r.n1 - 1 : null;
        r.price_trend = r.s1 >= 3 && r.s2 >= 3 && r.idx1 && r.idx2 ? r.idx2 / r.idx1 - 1 : null;
        r.share = null;
      }
      const total = this.get(`SELECT COUNT(*) n FROM auctions a WHERE ${w.sql}`, w.params).n;
      for (const r of rows) r.share = total ? r.n / total : null;
      return { mode: q.mode ?? 'theme', total, groups: rows };
    });
  }

  /** Drill-down for one group: per-rarity prices, biggest sales, top buyers, and what it's made of. */
  categoryDetail(q) {
    return this.cached('catdetail' + JSON.stringify(q), 30_000, () => {
      const w = where(q, 'a.');
      const params = { ...w.params, g: q.g };
      const mode = q.mode ?? 'theme';
      let member;
      if (mode === 'exact') member = `a.category = $g`;
      else {
        params.kind = mode;
        member = `a.category IN (SELECT category FROM category_tags WHERE kind = $kind AND tag = $g)`;
      }
      const base = `FROM auctions a WHERE ${w.sql} AND ${member}`;
      const SOLD = `a.status = 'settled_sold'`;
      const typical = new Map(this.prices({ range: q.range, shiny: q.shiny }).map((g) => [g.rarity + '|' + g.is_shiny, g.median]));
      const byRarity = this.all(
        `SELECT a.rarity, a.is_shiny, COUNT(*) n, SUM(${SOLD}) sold, AVG(CASE WHEN ${SOLD} THEN a.final_price END) avg_price ${base} GROUP BY 1, 2`,
        params,
      );
      const prices = new Map();
      for (const r of this.db.prepare(`SELECT a.rarity, a.is_shiny, a.final_price p ${base} AND ${SOLD} ORDER BY a.final_price`).iterate(params)) {
        const k = r.rarity + '|' + r.is_shiny;
        if (!prices.has(k)) prices.set(k, []);
        prices.get(k).push(r.p);
      }
      for (const r of byRarity) {
        const s = prices.get(r.rarity + '|' + r.is_shiny) ?? [];
        r.median = quantile(s, 0.5);
        r.typical = typical.get(r.rarity + '|' + r.is_shiny) ?? null;
      }
      byRarity.sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) || a.is_shiny - b.is_shiny);
      const topSales = this.all(
        `SELECT a.id, a.title, a.category, a.rarity, a.is_shiny, a.q_score, a.final_price, a.bid_count, a.end_at, u.username winner, a.winner_id
         FROM auctions a LEFT JOIN users u ON u.id = a.winner_id WHERE ${w.sql} AND ${member} AND ${SOLD}
         ORDER BY a.final_price DESC LIMIT 12`,
        params,
      );
      const buyers = this.all(
        `SELECT u.id, u.username, COUNT(*) won, SUM(a.final_price) spent FROM auctions a JOIN users u ON u.id = a.winner_id
         WHERE ${w.sql} AND ${member} AND ${SOLD} GROUP BY u.id ORDER BY spent DESC LIMIT 10`,
        params,
      );
      // What the group is made of: raw categories for themes/words, themes for countries.
      const parts =
        mode === 'country'
          ? this.all(
              `SELECT t2.tag part, COUNT(*) n, SUM(${SOLD}) sold, AVG(CASE WHEN ${SOLD} THEN a.final_price END) avg_price
               FROM auctions a CROSS JOIN category_tags t2 ON t2.category = a.category AND t2.kind = 'theme'
               WHERE ${w.sql} AND ${member} GROUP BY 1 ORDER BY n DESC LIMIT 15`,
              params,
            )
          : mode === 'exact'
            ? []
            : this.all(
                `SELECT a.category part, COUNT(*) n, SUM(${SOLD}) sold, AVG(CASE WHEN ${SOLD} THEN a.final_price END) avg_price
                 ${base} GROUP BY 1 ORDER BY n DESC LIMIT 15`,
                params,
              );
      return { byRarity, topSales, buyers, parts, partsLabel: mode === 'country' ? 'Theme' : 'Category' };
    });
  }

  /** When do bids land, when do things sell, does listing length matter. */
  timing(q) {
    return this.cached('timing' + JSON.stringify(q), 15_000, () => {
      const w = where(q, 'a.');
      const tz = (Number(q.tz) || 0) * 60000;
      // Seconds before the end at which every bid was placed (sold auctions only).
      const bidEdges = [1, 3, 5, 10, 30, 60, 300, 900, 3600, 3 * 3600, 6 * 3600, Infinity];
      const bidSecs = [];
      const lastSecs = [];
      for (const r of this.db
        .prepare(
          `SELECT (a.end_at - b.placed_at) / 1000.0 s, b.placed_at = a.last_bid_at is_last
           FROM bids b JOIN auctions a ON a.id = b.auction_id WHERE ${w.sql}`,
        )
        .iterate(w.params)) {
        bidSecs.push(r.s);
        if (r.is_last) lastSecs.push(r.s);
      }
      const hours = this.all(
        `SELECT ((a.end_at - ${tz}) / 3600000) % 24 h, COUNT(*) n, SUM(a.status = 'settled_sold') sold,
           AVG(CASE WHEN a.status = 'settled_sold' THEN a.final_price END) avg_price, AVG(a.bid_count) avg_bids
         FROM auctions a WHERE ${w.sql} GROUP BY 1 ORDER BY 1`,
        w.params,
      );
      const weekdays = this.all(
        `SELECT CAST(strftime('%w', (a.end_at - ${tz}) / 1000, 'unixepoch') AS INTEGER) d, COUNT(*) n,
           SUM(a.status = 'settled_sold') sold, AVG(CASE WHEN a.status = 'settled_sold' THEN a.final_price END) avg_price
         FROM auctions a WHERE ${w.sql} GROUP BY 1 ORDER BY 1`,
        w.params,
      );
      const durEdges = [1, 2, 4, 6, 12, 24, 48, Infinity];
      const durations = this.all(
        `SELECT (a.end_at - a.created_at) / 3600000.0 hrs, a.status = 'settled_sold' sold, a.final_price p
         FROM auctions a WHERE ${w.sql} AND a.created_at IS NOT NULL`,
        w.params,
      );
      const dur = durEdges.map((e) => ({ lt: e === Infinity ? null : e, n: 0, sold: 0, sum: 0 }));
      for (const r of durations) {
        let i = 0;
        while (r.hrs >= durEdges[i] - 0.01) i++;
        dur[i].n++;
        if (r.sold) {
          dur[i].sold++;
          dur[i].sum += r.p;
        }
      }
      return {
        bidTiming: histogram(bidSecs, bidEdges),
        winningBidTiming: histogram(lastSecs, bidEdges),
        hours,
        weekdays,
        durations: dur.map((d) => ({ lt: d.lt, n: d.n, sold: d.sold, avg_price: d.sold ? d.sum / d.sold : null })),
      };
    });
  }

  players(q) {
    return this.cached('players' + JSON.stringify(q), 15_000, () => {
      const w = where(q, 'a.');
      const player = String(q.player ?? '').trim();
      const playerFilter = player ? ' AND u.username LIKE $player' : '';
      const params = { ...w.params, ...(player ? { player: `%${player}%` } : {}) };
      const buyers = this.all(
        `SELECT u.id, u.username, COUNT(*) won, SUM(a.final_price) spent, AVG(a.final_price) avg_price,
           AVG(CASE WHEN a.base_amount > 0 THEN 1.0 * a.final_price / a.base_amount END) markup
         FROM auctions a JOIN users u ON u.id = a.winner_id
         WHERE ${w.sql} AND a.status = 'settled_sold'${playerFilter} GROUP BY u.id ORDER BY spent DESC LIMIT 50`,
        params,
      );
      const sellers = this.all(
        `SELECT u.id, u.username, COUNT(*) listed, SUM(a.status = 'settled_sold') sold,
           SUM(CASE WHEN a.status = 'settled_sold' THEN a.final_price END) revenue, AVG(a.base_amount) avg_base
         FROM auctions a JOIN users u ON u.id = a.seller_id
         WHERE ${w.sql}${playerFilter} GROUP BY u.id ORDER BY listed DESC LIMIT 50`,
        params,
      );
      const bidders = this.all(
        `SELECT u.id, u.username, COUNT(*) bids, COUNT(DISTINCT b.auction_id) auctions,
           SUM(a.winner_id = u.id AND b.placed_at = a.last_bid_at) wins,
           AVG((a.end_at - b.placed_at) / 1000.0) avg_secs_before_end,
           SUM(a.end_at - b.placed_at < 60000) late_bids
         FROM bids b JOIN auctions a ON a.id = b.auction_id JOIN users u ON u.id = b.bidder_id
         WHERE ${w.sql}${playerFilter} GROUP BY u.id ORDER BY bids DESC LIMIT 50`,
        params,
      );
      return { buyers, sellers, bidders };
    });
  }

  /** Paged results or active listings with free-text search, for the Browse tab. */
  auctions(q) {
    const active = q.status === 'active';
    const w = where(q, 'a.', active ? 'active' : q.status === 'cancelled' ? 'cancelled' : 'settled');
    const params = { ...w.params };
    let sql = w.sql;
    if (q.q) {
      params.q = `%${q.q}%`;
      sql += ` AND (a.title LIKE $q OR a.category LIKE $q OR a.search_doc LIKE $q)`;
    }
    if (q.status === 'sold' || q.status === 'unsold') sql += ` AND a.status = 'settled_${q.status}'`;
    if (q.user) {
      params.user = q.user;
      sql += ` AND (a.seller_id = $user OR a.winner_id = $user)`;
    }
    if (q.tag && q.tagKind) {
      // Auctions in one Categories-tab group.
      params.tag = q.tag;
      if (q.tagKind === 'exact') sql += ` AND a.category = $tag`;
      else {
        params.tagKind = q.tagKind;
        sql += ` AND a.category IN (SELECT category FROM category_tags WHERE kind = $tagKind AND tag = $tag)`;
      }
    }
    if (q.card) {
      params.card = q.card;
      sql += ` AND a.card_id = $card`;
    }
    if (Number(q.minPrice) > 0) {
      params.minPrice = Number(q.minPrice);
      sql += active ? ` AND a.base_amount >= $minPrice` : ` AND a.final_price >= $minPrice`;
    }
    if (q.sort === 'resold') sql += ` AND c.times_sold >= 2`;
    const order = active ? ({
      price: 'a.base_amount DESC',
      bids: 'a.current_bid DESC NULLS LAST',
      resold: 'c.times_sold DESC, a.created_at DESC',
    }[q.sort] ?? 'a.created_at DESC') :
      {
        price: 'a.final_price DESC NULLS LAST',
        bids: 'a.bid_count DESC',
        markup: '1.0 * a.final_price / MAX(a.base_amount, 1) DESC NULLS LAST',
        // Most-traded cards first, each card's sales together (newest first) so its price history reads top-down.
        resold: 'c.times_sold DESC, a.card_id, a.end_at DESC',
      }[q.sort] ?? 'a.end_at DESC';
    const limit = 50;
    const page = Math.max(1, Number(q.page) || 1);
    const rows = this.all(
      `SELECT a.id, a.card_id, a.title, a.category, a.rarity, a.is_shiny, a.atk, a.def, a.q_score, a.pageviews, a.base_amount,
         a.final_price, a.current_bid, a.first_source, a.status, a.bid_count, a.bidder_count, a.end_at, a.created_at, s.username seller, w.username winner,
         a.seller_id, a.winner_id, c.times_sold, c.times_listed
       FROM auctions a LEFT JOIN users s ON s.id = a.seller_id LEFT JOIN users w ON w.id = a.winner_id
       LEFT JOIN cards c ON c.id = a.card_id
       WHERE ${sql} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${(page - 1) * limit}`,
      params,
    );
    return { rows: rows.slice(0, limit), page, hasMore: rows.length > limit };
  }

  /** One auction with its bids, other sales of the same card, and comparable sales. */
  auction(id) {
    const a = this.get(
      `SELECT a.*, s.username seller, w.username winner, c.image_url, c.url, c.summary
       FROM auctions a LEFT JOIN users s ON s.id = a.seller_id LEFT JOIN users w ON w.id = a.winner_id
       LEFT JOIN cards c ON c.id = a.card_id WHERE a.id = $id`,
      { id },
    );
    if (!a) return null;
    const bids = this.all(
      `SELECT b.amount, b.placed_at, u.username, b.bidder_id FROM bids b LEFT JOIN users u ON u.id = b.bidder_id
       WHERE b.auction_id = $id ORDER BY b.placed_at`,
      { id },
    );
    const sameCard = this.all(
      `SELECT id, end_at, status, base_amount, final_price, bid_count FROM auctions
       WHERE card_id = $card AND final = 1 AND id != $id ORDER BY end_at DESC LIMIT 50`,
      { card: a.card_id, id },
    );
    return { auction: a, bids, sameCard, comparable: this.comparable({ rarity: a.rarity, shiny: a.is_shiny, q_score: a.q_score }) };
  }

  /** Find distinct card IDs; title matches can legitimately return several physical cards. */
  cards(term) {
    const q = String(term ?? '').trim().slice(0, 120);
    if (!q) return this.all(`SELECT id, title, category, rarity, is_shiny, image_url, q_score, times_sold, times_listed
      FROM cards ORDER BY times_sold DESC, times_listed DESC, title LIMIT 30`);
    if (q.length < 2) return [];
    return this.all(`SELECT id, title, category, rarity, is_shiny, image_url, q_score, times_sold, times_listed
      FROM cards WHERE id = $q OR instr(lower(title), lower($q)) > 0
      ORDER BY CASE WHEN id = $q THEN 0 WHEN lower(title) = lower($q) THEN 1
        WHEN lower(title) LIKE lower($prefix) THEN 2 ELSE 3 END,
        times_sold DESC, times_listed DESC, title LIMIT 30`, { q, prefix: `${q}%` });
  }

  /** All-time recorded stats for one physical card, with a bounded price chart and paged auction history. */
  card(id, requestedPage = 1) {
    if (!id || String(id).length > 128) return null;
    const card = this.get(`SELECT id, title, url, lang, rarity, atk, def, q_score, pageviews,
      category, image_url, summary, is_shiny, created_at, updated_at FROM cards WHERE id = $id`, { id });
    if (!card) return null;
    const stats = this.get(`SELECT COUNT(*) listings,
      SUM(final = 1 AND status = 'settled_sold') sold,
      SUM(final = 1 AND status = 'settled_unsold') unsold,
      SUM(final = 1 AND status = 'cancelled') cancelled,
      SUM(final = 0 AND status = 'active') active,
      SUM(final = 0 AND status != 'active') awaiting_result,
      SUM(CASE WHEN status = 'settled_sold' AND final = 1 THEN final_price ELSE 0 END) volume,
      AVG(CASE WHEN status = 'settled_sold' AND final = 1 THEN final_price END) avg_price,
      AVG(CASE WHEN status LIKE 'settled%' AND final = 1 THEN base_amount END) avg_start,
      AVG(CASE WHEN status LIKE 'settled%' AND final = 1 THEN bid_count END) avg_bids,
      SUM(CASE WHEN status LIKE 'settled%' AND final = 1 THEN bid_count ELSE 0 END) total_bids,
      COUNT(DISTINCT CASE WHEN status = 'settled_sold' AND final = 1 THEN winner_id END) buyers,
      MIN(first_seen) first_recorded, MAX(last_seen) last_recorded,
      MIN(created_at) first_listed, MAX(created_at) last_listed
      FROM auctions WHERE card_id = $id`, { id });
    const sales = this.all(`SELECT id, end_at, final_price price, base_amount start_price, rarity
      FROM auctions WHERE card_id = $id AND final = 1 AND status = 'settled_sold'
      ORDER BY end_at`, { id });
    const prices = sales.map((s) => s.price).filter((p) => p != null).sort((a, b) => a - b);
    const recentPrices = sales.slice(-5).map((s) => s.price).filter((p) => p != null).sort((a, b) => a - b);
    const lastSale = sales.at(-1) ?? null;
    const page = Math.min(100_000, Math.max(1, Math.floor(Number(requestedPage) || 1)));
    const limit = 50;
    const history = this.all(`SELECT a.id, a.created_at, a.end_at, a.status, a.final, a.rarity,
      a.is_shiny, a.base_amount, a.current_bid, a.final_price, a.bid_count,
      a.seller_id, a.winner_id, s.username seller, w.username winner
      FROM auctions a LEFT JOIN users s ON s.id = a.seller_id LEFT JOIN users w ON w.id = a.winner_id
      WHERE a.card_id = $id ORDER BY a.created_at DESC LIMIT ${limit + 1} OFFSET ${(page - 1) * limit}`, { id });
    const completed = (stats.sold ?? 0) + (stats.unsold ?? 0);
    return {
      card,
      stats: { ...stats, ...spread(prices), recent_median: quantile(recentPrices, 0.5),
        sell_through: completed ? (stats.sold ?? 0) / completed : null,
        last_sale_price: lastSale?.price ?? null, last_sale_at: lastSale?.end_at ?? null },
      priceHistory: sales.slice(-200),
      priceHistoryTruncated: sales.length > 200,
      history: { rows: history.slice(0, limit), page, hasMore: history.length > limit },
      comparable: this.comparable({ rarity: card.rarity, shiny: card.is_shiny, q_score: card.q_score }),
    };
  }

  /**
   * What do similar cards go for: same rarity and shiny-ness, q_score within ±band, last 30 days.
   * Also usable on its own from the Estimate panel.
   */
  comparable({ rarity, shiny, q_score, band = 5, days = 30 }) {
    const params = { rarity, since: Date.now() - days * 86400e3 };
    let sql = `final = 1 AND status LIKE 'settled%' AND rarity = $rarity AND end_at >= $since`;
    if (shiny === 0 || shiny === 1 || shiny === '0' || shiny === '1') {
      sql += ` AND is_shiny = $shiny`;
      params.shiny = Number(shiny);
    }
    if (q_score != null && q_score !== '') {
      sql += ` AND q_score BETWEEN $lo AND $hi`;
      params.lo = Number(q_score) - band;
      params.hi = Number(q_score) + band;
    }
    const rows = this.all(`SELECT status, final_price p, base_amount FROM auctions WHERE ${sql}`, params);
    const sold = rows.filter((r) => r.status === 'settled_sold').map((r) => r.p).sort((x, y) => x - y);
    return { n: rows.length, sold: sold.length, ...spread(sold) };
  }

  users(term) {
    return this.all(`SELECT id, username FROM users WHERE username LIKE $t ORDER BY last_seen DESC LIMIT 20`, { t: `%${term}%` });
  }
}
