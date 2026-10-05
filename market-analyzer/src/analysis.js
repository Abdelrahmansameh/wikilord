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
  const observed = mode === 'observed';
  const parts = observed ? ['1 = 1'] : active ? [`${a}final = 0`, `${a}status = 'active'`] : cancelled ?
    [`${a}final = 1`, `${a}status = 'cancelled'`] : [`${a}final = 1`, `${a}status IN ('settled_sold', 'settled_unsold')`];
  const params = {};
  if (RANGES[q.range]) {
    parts.push(`${a}${observed ? 'first_seen' : active ? 'created_at' : 'end_at'} >= $since`);
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

const LOG_EDGES = [1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000, 50000, Infinity];

/** Exact quantiles from sorted price frequencies; repeated sales never need a JS object each. */
function priceStats(frequencies, includeHistogram = false) {
  const n = frequencies.reduce((sum, row) => sum + row.n, 0);
  const wanted = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((p) => {
    const position = (n - 1) * p;
    return { lo: Math.floor(position), hi: Math.ceil(position), fraction: position - Math.floor(position) };
  });
  let seen = 0;
  const counts = new Array(LOG_EDGES.length).fill(0);
  for (const row of frequencies) {
    const next = seen + row.n;
    for (const target of wanted) {
      if (target.lo >= seen && target.lo < next) target.low = row.p;
      if (target.hi >= seen && target.hi < next) target.high = row.p;
    }
    if (includeHistogram) {
      let i = 0;
      while (row.p >= LOG_EDGES[i]) i++;
      counts[i] += row.n;
    }
    seen = next;
  }
  const values = wanted.map((target) => n ? Math.round((target.low + (target.high - target.low) * target.fraction) * 10) / 10 : null);
  const result = Object.fromEntries(['min', 'p10', 'p25', 'median', 'p75', 'p90', 'max'].map((key, i) => [key, values[i]]));
  // Preserve the stored endpoints (including NULL) rather than interpolating them.
  result.min = frequencies[0]?.p ?? null;
  result.max = frequencies.at(-1)?.p ?? null;
  if (includeHistogram) result.histogram = LOG_EDGES.map((edge, i) => ({ lt: edge === Infinity ? null : edge, n: counts[i] }));
  return result;
}

/** SQL for the histogram() bucket index of `expr`, so large ranges can be counted without loading every row. */
function bucketSql(expr, edges, offset = 0) {
  const last = edges.length - 1;
  const cases = edges.slice(0, last).map((e, i) => `WHEN ${expr} < ${e - offset} THEN ${i}`).join(' ');
  return `CASE WHEN ${expr} IS NULL THEN 0 ${cases} ELSE ${last} END`;
}

export class Analysis {
  constructor(store) {
    this.db = store.db;
    this.store = store;
    this.cache = new Map();
    this.statements = new Map();
  }

  /**
   * Short TTL cache for results other queries build on (range start, typical prices). Whole dashboard
   * responses are cached by AnalysisClient, which also decides when they are recomputed.
   */
  cached(key, ttlMs, fn) {
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = fn();
    this.cache.set(key, { value, until: Date.now() + ttlMs });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  all(sql, params = {}) {
    return this.statement(sql).all(params);
  }

  get(sql, params = {}) {
    return this.statement(sql).get(params);
  }

  statement(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
      if (this.statements.size > 100) this.statements.delete(this.statements.keys().next().value);
    }
    return statement;
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
  }

  /** How many times each recorded card sold (0 = auctioned but never sold), as a count of cards per number of sales. */
  turnover(q) {
    const w = where(q);
    const rows = this.all(
      `SELECT sold, COUNT(*) cards FROM (
         SELECT card_id, SUM(status = 'settled_sold') sold FROM auctions WHERE ${w.sql} AND card_id IS NOT NULL GROUP BY card_id
       ) GROUP BY sold ORDER BY sold`,
      w.params,
    );
    return { total: rows.reduce((s, r) => s + r.cards, 0), rows };
  }

  /** Number of distinct auction rows observed per physical card, including unfinished and cancelled listings. */
  auctionAppearances(q) {
    const w = where(q, '', 'observed');
    const rows = this.all(`SELECT auctions_seen, COUNT(*) cards FROM (
      SELECT card_id, COUNT(*) auctions_seen FROM auctions
      WHERE ${w.sql} AND card_id IS NOT NULL GROUP BY card_id
    ) GROUP BY auctions_seen ORDER BY auctions_seen`, w.params);
    return { total: rows.reduce((sum, row) => sum + row.cards, 0), rows };
  }

  /** Per rarity (and shiny): sell-through, price spread, bids, markup over the starting price. */
  prices(q) {
    const filters = { range: q.range || 'all', rarity: q.rarity || '', shiny: q.shiny ?? '' };
    return this.cached('prices' + JSON.stringify(filters), 60_000, () => {
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
      for (const r of this.statement(`SELECT rarity, is_shiny, final_price p, COUNT(*) n FROM auctions
        WHERE ${w.sql} AND status = 'settled_sold'
        GROUP BY rarity, is_shiny, final_price ORDER BY final_price`).iterate(w.params)) {
        const k = r.rarity + '|' + r.is_shiny;
        if (!prices.has(k)) prices.set(k, []);
        prices.get(k).push(r);
      }
      for (const g of groups) {
        const s = prices.get(g.rarity + '|' + g.is_shiny) ?? [];
        Object.assign(g, priceStats(s, true));
      }
      groups.sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) || a.is_shiny - b.is_shiny);
      return groups;
    });
  }

  /** Starting price vs sell-through and final price, per rarity. */
  startingPrice(q) {
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
  }

  /** Price against a card stat, for one rarity: a sample of sold auctions. */
  scatter(q) {
    const x = { q_score: 'q_score', atk: 'atk', def: 'def', power: 'atk + def', pageviews: 'pageviews', base: 'base_amount' }[q.x] ?? 'q_score';
    const w = where(q);
    return this.all(
      `SELECT ${x} x, final_price y, rarity, title FROM auctions
       WHERE ${w.sql} AND status = 'settled_sold' AND ${x} IS NOT NULL ORDER BY end_at DESC LIMIT 4000`,
      w.params,
    );
  }

  /**
   * How auctions are grouped on the Categories tab. mode = theme | country | word (via category_tags) | exact (raw text).
   * Returns SQL pieces that put the group key in column `g`.
   */
  _group(mode) {
    if (mode === 'exact') return { join: '', key: 'a.category', label: 'a.category', extra: ' AND a.category IS NOT NULL', params: {} };
    const kind = { theme: 'theme', country: 'country', word: 'word' }[mode] ?? 'theme';
    return { join: 'JOIN category_tags t ON t.category = a.category AND t.kind = $kind', key: 't.tag', label: 'MIN(t.label)', extra: '', params: { kind } };
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
    // Trends need one indexed timestamp, not historical counts of every auction, bid, user and card.
    const oldest = this.cached('oldest-final', 300_000, () => this.get(`SELECT MIN(end_at) t FROM auctions WHERE final = 1`).t);
    return Math.max(Date.now() - (RANGES[q.range] ?? Infinity), oldest ?? Date.now());
  }

  /** One row per category group with every metric the Categories tab can sort by. */
  categoryGroups(q) {
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
       SELECT ${G.key} g, ${G.label} label, COUNT(*) n, SUM(${SOLD}) sold,
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
    // Word tags multiply each category many times; aggregate their repeated prices before expanding them.
    for (const r of this.all(
      q.mode === 'word' ? `WITH by_category AS (
         SELECT a.category, a.final_price p, COUNT(*) n FROM auctions a WHERE ${w.sql} AND ${SOLD} GROUP BY 1, 2
       ), s AS (SELECT ${G.key} g, a.p, SUM(a.n) n FROM by_category a ${G.join}
         WHERE 1 = 1${G.extra} GROUP BY 1, 2),
            o AS (SELECT g, p, n, SUM(n) OVER (PARTITION BY g ORDER BY p ROWS UNBOUNDED PRECEDING) upto,
              SUM(n) OVER (PARTITION BY g ORDER BY p ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) c FROM s)
       SELECT g, AVG(p) median FROM o
       WHERE upto > (c - 1) / 2 AND upto - n <= c / 2 GROUP BY g` :
      `WITH s AS (SELECT ${G.key} g, a.final_price p, COUNT(*) n ${from} AND ${SOLD} GROUP BY 1, 2),
            o AS (SELECT g, p, n, SUM(n) OVER (PARTITION BY g ORDER BY p ROWS UNBOUNDED PRECEDING) upto,
              SUM(n) OVER (PARTITION BY g ORDER BY p ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) c FROM s)
       SELECT g, AVG(p) median FROM o WHERE upto > (c - 1) / 2 AND upto - n <= c / 2 GROUP BY g`,
      params,
    ))
      if (byG.has(r.g)) byG.get(r.g).median = r.median;
    // Distinct-card counts and resale rates share one per-card grouping instead of two distinct sorts.
    for (const r of this.all(
      q.mode === 'word' ? `WITH by_category AS (
         SELECT a.category, a.card_id, SUM(${SOLD}) k FROM auctions a WHERE ${w.sql} GROUP BY 1, 2
       ) SELECT g, COUNT(card_id) cards, AVG(CASE WHEN k >= 1 THEN k >= 2 END) resold
       FROM (SELECT ${G.key} g, a.card_id, SUM(a.k) k FROM by_category a ${G.join}
         WHERE 1 = 1${G.extra} GROUP BY 1, 2) GROUP BY g` :
      `SELECT g, COUNT(card_id) cards, AVG(CASE WHEN k >= 1 THEN k >= 2 END) resold
       FROM (SELECT ${G.key} g, a.card_id, SUM(${SOLD}) k ${from} GROUP BY 1, 2) GROUP BY g`,
      params,
    ))
      if (byG.has(r.g)) {
        byG.get(r.g).cards = r.cards;
        if (r.resold != null) byG.get(r.g).resold = r.resold;
      }
    // Rarity mix, for the little stacked bar.
    for (const r of this.all(q.mode === 'word' ? `WITH by_category AS (
      SELECT a.category, a.rarity, COUNT(*) n FROM auctions a WHERE ${w.sql} GROUP BY 1, 2
    ) SELECT ${G.key} g, a.rarity r, SUM(a.n) n FROM by_category a ${G.join}
      WHERE 1 = 1${G.extra} GROUP BY 1, 2` : `SELECT ${G.key} g, a.rarity r, COUNT(*) n ${from} GROUP BY 1, 2`, params)) {
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
  }

  /** Drill-down for one group: per-rarity prices, biggest sales, top buyers, and what it's made of. */
  categoryDetail(q) {
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
    for (const r of this.statement(`SELECT a.rarity, a.is_shiny, a.final_price p, COUNT(*) n
      ${base} AND ${SOLD} GROUP BY a.rarity, a.is_shiny, a.final_price ORDER BY a.final_price`).iterate(params)) {
      const k = r.rarity + '|' + r.is_shiny;
      if (!prices.has(k)) prices.set(k, []);
      prices.get(k).push(r);
    }
    for (const r of byRarity) {
      const s = prices.get(r.rarity + '|' + r.is_shiny) ?? [];
      r.median = priceStats(s).median;
      r.typical = typical.get(r.rarity + '|' + r.is_shiny) ?? null;
    }
    byRarity.sort((a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) || a.is_shiny - b.is_shiny);
    const topSales = this.all(
      `WITH top AS MATERIALIZED (
         SELECT a.id FROM auctions a WHERE ${w.sql} AND ${member} AND ${SOLD}
         ORDER BY a.final_price DESC LIMIT 12
       ) SELECT a.id, a.title, a.category, a.rarity, a.is_shiny, a.q_score, a.final_price, a.bid_count, a.end_at, u.username winner, a.winner_id
       FROM top JOIN auctions a ON a.id = top.id LEFT JOIN users u ON u.id = a.winner_id
       ORDER BY a.final_price DESC LIMIT 12`,
      params,
    );
    const buyers = this.all(
      `WITH totals AS (
         SELECT a.winner_id id, COUNT(*) won, SUM(a.final_price) spent
         FROM auctions a WHERE ${w.sql} AND ${member} AND ${SOLD} GROUP BY a.winner_id
       ) SELECT u.id, u.username, t.won, t.spent FROM totals t JOIN users u ON u.id = t.id
       ORDER BY t.spent DESC LIMIT 10`,
      params,
    );
    // What the group is made of: raw categories for themes/words, themes for countries.
    const parts =
      mode === 'country'
        ? this.all(
            `SELECT t2.tag part, COUNT(*) n, SUM(${SOLD}) sold, AVG(CASE WHEN ${SOLD} THEN a.final_price END) avg_price
             FROM auctions a JOIN category_tags t2 ON t2.category = a.category AND t2.kind = 'theme'
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
  }

  /** When do bids land, when do things sell, does listing length matter. */
  timing(q) {
    const w = where(q, 'a.');
    const tz = (Number(q.tz) || 0) * 60000;
    // Read bid-index pages in auction-ID order instead of seeking random UUIDs in end-time order.
    const bidEdges = [1, 3, 5, 10, 30, 60, 300, 900, 3600, 3 * 3600, 6 * 3600, Infinity];
    const bidCounts = bidEdges.map((e) => ({ lt: e === Infinity ? null : e, n: 0 }));
    const lastCounts = bidEdges.map((e) => ({ lt: e === Infinity ? null : e, n: 0 }));
    for (const r of this.all(
      `WITH settled AS MATERIALIZED (
         SELECT a.id, a.end_at, a.last_bid_at FROM auctions a WHERE ${w.sql} ORDER BY a.id
       ) SELECT ${bucketSql('s', bidEdges)} i, COUNT(*) n, SUM(is_last) last FROM (
         SELECT (a.end_at - b.placed_at) / 1000.0 s, b.placed_at = a.last_bid_at is_last
         FROM settled a CROSS JOIN bids b ON b.auction_id = a.id
       ) GROUP BY 1`,
      w.params,
    )) {
      bidCounts[r.i].n = r.n;
      lastCounts[r.i].n = r.last ?? 0;
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
    const dur = durEdges.map((e) => ({ lt: e === Infinity ? null : e, n: 0, sold: 0, sum: 0 }));
    for (const r of this.all(
      `SELECT ${bucketSql('hrs', durEdges, 0.01)} i, COUNT(*) n, SUM(sold) sold, TOTAL(CASE WHEN sold THEN p END) sum FROM (
         SELECT (a.end_at - a.created_at) / 3600000.0 hrs, a.status = 'settled_sold' sold, a.final_price p
         FROM auctions a WHERE ${w.sql} AND a.created_at IS NOT NULL
       ) GROUP BY 1`,
      w.params,
    ))
      Object.assign(dur[r.i], { n: r.n, sold: r.sold ?? 0, sum: r.sum });
    return {
      bidTiming: bidCounts,
      winningBidTiming: lastCounts,
      hours,
      weekdays,
      durations: dur.map((d) => ({ lt: d.lt, n: d.n, sold: d.sold, avg_price: d.sold ? d.sum / d.sold : null })),
    };
  }

  players(q) {
    const w = where(q, 'a.');
    const player = String(q.player ?? '').trim();
    const params = { ...w.params, ...(player ? { player: `%${player}%` } : {}) };
    const member = (column) => player ? ` AND ${column} IN (SELECT id FROM users WHERE username LIKE $player)` : '';
    // Join display names after grouping; millions of auctions otherwise repeat the same user lookup.
    const buyers = this.all(
      `WITH totals AS (SELECT a.winner_id id, COUNT(*) won, SUM(a.final_price) spent, AVG(a.final_price) avg_price,
         AVG(CASE WHEN a.base_amount > 0 THEN 1.0 * a.final_price / a.base_amount END) markup
       FROM auctions a WHERE ${w.sql} AND a.status = 'settled_sold'${member('a.winner_id')} GROUP BY a.winner_id)
       SELECT u.id, u.username, t.won, t.spent, t.avg_price, t.markup
       FROM totals t JOIN users u ON u.id = t.id ORDER BY t.spent DESC LIMIT 50`,
      params,
    );
    const sellers = this.all(
      `WITH totals AS (SELECT a.seller_id id, COUNT(*) listed, SUM(a.status = 'settled_sold') sold,
         SUM(CASE WHEN a.status = 'settled_sold' THEN a.final_price END) revenue, AVG(a.base_amount) avg_base
       FROM auctions a WHERE ${w.sql}${member('a.seller_id')} GROUP BY a.seller_id)
       SELECT u.id, u.username, t.listed, t.sold, t.revenue, t.avg_base
       FROM totals t JOIN users u ON u.id = t.id ORDER BY t.listed DESC LIMIT 50`,
      params,
    );
    // A username search can start from the selective bidder index. Broad views instead seek bids in ID order.
    const bidCte = player ? '' : `settled AS MATERIALIZED (
      SELECT a.id, a.end_at, a.last_bid_at, a.winner_id FROM auctions a WHERE ${w.sql} ORDER BY a.id
    ), `;
    const bidFrom = player ? `FROM bids b JOIN auctions a ON a.id = b.auction_id
      WHERE ${w.sql}${member('b.bidder_id')}` : `FROM settled a CROSS JOIN bids b ON b.auction_id = a.id`;
    const bidders = this.all(
      `WITH ${bidCte}totals AS (SELECT b.bidder_id id, COUNT(*) bids, COUNT(DISTINCT b.auction_id) auctions,
         SUM(a.winner_id = b.bidder_id AND b.placed_at = a.last_bid_at) wins,
         AVG((a.end_at - b.placed_at) / 1000.0) avg_secs_before_end,
         SUM(a.end_at - b.placed_at < 60000) late_bids
       ${bidFrom} GROUP BY b.bidder_id)
       SELECT u.id, u.username, t.bids, t.auctions, t.wins, t.avg_secs_before_end, t.late_bids
       FROM totals t JOIN users u ON u.id = t.id ORDER BY t.bids DESC LIMIT 50`,
      params,
    );
    return { buyers, sellers, bidders };
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
    const limit = Math.min(50, Math.max(1, Math.floor(Number(q.limit) || 50)));
    const page = Math.min(100_000, Math.max(1, Math.floor(Number(q.page) || 1)));
    const offset = (page - 1) * limit;
    // Every eligible card contributes at least one matching auction. Taking the first offset+limit+1
    // cards therefore contains the complete requested page, without joining all historical auctions
    // to cards. Card ID breaks sale-count ties in the same order as the settled-auction list.
    const pageCte = q.sort === 'resold' && !active ? `eligible AS MATERIALIZED (
        SELECT c.id, c.times_sold FROM cards c WHERE c.times_sold >= 2
          AND EXISTS (SELECT 1 FROM auctions a WHERE a.card_id = c.id AND ${sql})
        ORDER BY c.times_sold DESC, c.id LIMIT ${offset + limit + 1}
      ), page AS MATERIALIZED (
        SELECT a.id FROM eligible c CROSS JOIN auctions a ON a.card_id = c.id
        WHERE ${sql} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}
      )` : `page AS MATERIALIZED (
        SELECT a.id FROM auctions a ${q.sort === 'resold' ? 'LEFT JOIN cards c ON c.id = a.card_id' : ''}
        WHERE ${sql} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}
      )`;
    const rows = this.all(
      `WITH ${pageCte} SELECT a.id, a.card_id, a.title, a.category, a.rarity, a.is_shiny, a.atk, a.def, a.q_score, a.pageviews, a.base_amount,
         a.final_price, a.current_bid, a.first_source, a.status, a.bid_count, a.bidder_count, a.end_at, a.created_at, s.username seller, w.username winner,
         a.seller_id, a.winner_id, c.times_sold, c.times_listed
       FROM page p JOIN auctions a ON a.id = p.id
       LEFT JOIN users s ON s.id = a.seller_id LEFT JOIN users w ON w.id = a.winner_id
       LEFT JOIN cards c ON c.id = a.card_id
       ORDER BY ${order}`,
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
    return { auction: a, bids, sameCard, comparable: this.comparable({ rarity: a.rarity, shiny: a.is_shiny }) };
  }

  /** Find distinct card IDs; title matches can legitimately return several physical cards. */
  cards(term) {
    const q = String(term ?? '').trim().slice(0, 120);
    if (!q) return this.all(`SELECT id, title, category, rarity, is_shiny, image_url, q_score, times_sold, times_listed
      FROM cards ORDER BY times_sold DESC, times_listed DESC, title LIMIT 30`);
    if (q.length < 2) return [];
    // Physical IDs are UUIDs. An exact ID lookup should not lowercase every title in the database.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q))
      return this.all(`SELECT id, title, category, rarity, is_shiny, image_url, q_score, times_sold, times_listed
        FROM cards WHERE id = $q`, { q });
    // Scan the compact title index for substrings, then fetch metadata only for matching rows. An OR on
    // id/title used to scan every wide card record (including summaries and image URLs) for each keystroke.
    const titleIndex = this.cached('cards-title-index', 300_000, () => this.get(
      `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'cards_title'`,
    ) ? 'INDEXED BY cards_title' : '');
    return this.all(`SELECT id, title, category, rarity, is_shiny, image_url, q_score, times_sold, times_listed
      FROM cards WHERE rowid IN (
        SELECT rowid FROM cards ${titleIndex} WHERE instr(lower(title), lower($q)) > 0
        UNION SELECT rowid FROM cards WHERE id = $q
      )
      ORDER BY CASE WHEN id = $q THEN 0 WHEN lower(title) = lower($q) THEN 1
        WHEN lower(title) LIKE lower($prefix) THEN 2 ELSE 3 END,
        times_sold DESC, times_listed DESC, title LIMIT 30`, { q, prefix: `${q}%` });
  }

  /** Top 500 cards by one all-time metric, with the other metrics shown alongside it. */
  cardRankings(sort = 'sold') {
    const by = ['sold', 'listed', 'median', 'volume'].includes(sort) ? sort : 'sold';
    const fields = `c.id, c.title, c.category, c.rarity, c.is_shiny, c.image_url, c.q_score,
      c.times_sold, c.times_listed`;
    // Approximate ANALYZE statistics on final=1 can incorrectly select the much wider end-time index.
    // This existing partial index is ordered by card and price, exactly what all-time rankings need.
    const priceIndex = this.cached('sold-price-index', 300_000, () => this.get(
      `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'auctions_sold_card_price'`,
    ) ? 'INDEXED BY auctions_sold_card_price' : '');
    let rows;
    if (by === 'sold' || by === 'listed') {
      const order = by === 'listed' ? 'c.times_listed DESC' : 'c.times_sold DESC';
      rows = this.all(`SELECT ${fields} FROM cards c WHERE c.times_listed > 0
        ORDER BY ${order} LIMIT 500`);
    } else if (by === 'volume') {
      rows = this.all(`WITH totals AS MATERIALIZED (
        SELECT card_id, SUM(final_price) volume FROM auctions ${priceIndex}
        WHERE final = 1 AND status = 'settled_sold' AND final_price IS NOT NULL
        GROUP BY card_id
      ), top AS (
        SELECT volume FROM totals t WHERE EXISTS (SELECT 1 FROM cards c WHERE c.id = t.card_id)
        ORDER BY volume DESC LIMIT 500
      ) SELECT ${fields}, totals.volume FROM totals JOIN cards c ON c.id = totals.card_id
        WHERE totals.volume >= (SELECT MIN(volume) FROM top)
        ORDER BY totals.volume DESC, c.times_sold DESC, c.title, c.id LIMIT 500`);
    } else {
      rows = this.all(`WITH ordered AS (
        SELECT card_id, final_price,
          ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY final_price) rn,
          COUNT(*) OVER (PARTITION BY card_id ORDER BY final_price ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) n
        FROM auctions ${priceIndex} WHERE final = 1 AND status = 'settled_sold' AND final_price IS NOT NULL
      ), medians AS MATERIALIZED (
        SELECT card_id, AVG(final_price) median FROM ordered
        WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY card_id
      ), top AS (
        SELECT median FROM medians m WHERE EXISTS (SELECT 1 FROM cards c WHERE c.id = m.card_id)
        ORDER BY median DESC LIMIT 500
      ) SELECT ${fields}, medians.median FROM medians JOIN cards c ON c.id = medians.card_id
        WHERE medians.median >= (SELECT MIN(median) FROM top)
        ORDER BY medians.median DESC, c.times_sold DESC, c.title, c.id LIMIT 500`);
    }
    if (!rows.length) return rows;
    const params = Object.fromEntries(rows.map((r, i) => [`id${i}`, r.id]));
    const prices = this.all(`SELECT card_id, final_price p, COUNT(*) n FROM auctions ${priceIndex}
      WHERE final = 1 AND status = 'settled_sold' AND final_price IS NOT NULL
        AND card_id IN (${rows.map((_r, i) => `$id${i}`).join(', ')})
      GROUP BY card_id, final_price ORDER BY card_id, final_price`, params);
    const byCard = new Map();
    for (const sale of prices) {
      if (!byCard.has(sale.card_id)) byCard.set(sale.card_id, { prices: [], volume: 0 });
      const stats = byCard.get(sale.card_id);
      stats.prices.push(sale);
      stats.volume += sale.p * sale.n;
    }
    return rows.map((r) => ({ ...r, median: priceStats(byCard.get(r.id)?.prices ?? []).median,
      volume: byCard.get(r.id)?.volume ?? 0 }));
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
    const frequencies = this.all(`SELECT final_price p, COUNT(*) n FROM auctions
      WHERE card_id = $id AND final = 1 AND status = 'settled_sold'
      GROUP BY final_price ORDER BY final_price`, { id });
    // Only chart points and the latest five sales need complete auction rows.
    const sales = this.all(`SELECT id, end_at, final_price price, base_amount start_price, rarity
      FROM auctions WHERE card_id = $id AND final = 1 AND status = 'settled_sold'
      ORDER BY end_at DESC LIMIT 200`, { id });
    const recentPrices = sales.slice(0, 5).map((s) => s.price).filter((p) => p != null).sort((a, b) => a - b);
    const lastSale = sales[0] ?? null;
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
      stats: { ...stats, ...priceStats(frequencies.filter((r) => r.p != null)), recent_median: quantile(recentPrices, 0.5),
        sell_through: completed ? (stats.sold ?? 0) / completed : null,
        last_sale_price: lastSale?.price ?? null, last_sale_at: lastSale?.end_at ?? null },
      priceHistory: sales.reverse(),
      priceHistoryTruncated: stats.sold > 200,
      history: { rows: history.slice(0, limit), page, hasMore: history.length > limit },
      comparable: this.comparable({ rarity: card.rarity, shiny: card.is_shiny }),
    };
  }

  /**
   * Market benchmark: same rarity and shininess, last 30 days. Individual collection demand varies.
   * An optional q_score band remains available to existing API consumers.
   * Also usable on its own from the Estimate panel.
   */
  comparable({ rarity, shiny, q_score, band = 5, days = 30 }) {
    const options = { rarity, shiny, q_score, band, days };
    // Physical copies of the same article share these comparables. Reopening them must not rescan the
    // whole market for each copy or each auction detail.
    return this.cached(JSON.stringify(['comparable', rarity, String(shiny ?? ''), String(q_score ?? ''), band, days]),
      60_000, () => this._comparable(options));
  }

  _comparable({ rarity, shiny, q_score, band, days }) {
    const params = { rarity, since: Date.now() - days * 86400e3 };
    let sql = `final = 1 AND status IN ('settled_sold', 'settled_unsold') AND rarity = $rarity AND end_at >= $since`;
    if (shiny === 0 || shiny === 1 || shiny === '0' || shiny === '1') {
      sql += ` AND is_shiny = $shiny`;
      params.shiny = Number(shiny);
    }
    if (q_score != null && q_score !== '') {
      sql += ` AND q_score BETWEEN $lo AND $hi`;
      params.lo = Number(q_score) - band;
      params.hi = Number(q_score) + band;
    }
    const rows = this.all(`SELECT status, final_price p, COUNT(*) n FROM auctions
      WHERE ${sql} GROUP BY status, final_price ORDER BY final_price`, params);
    const sold = rows.filter((r) => r.status === 'settled_sold');
    return { n: rows.reduce((sum, r) => sum + r.n, 0), sold: sold.reduce((sum, r) => sum + r.n, 0), ...priceStats(sold) };
  }

  users(term) {
    return this.all(`SELECT id, username FROM users WHERE username LIKE $t ORDER BY last_seen DESC LIMIT 20`, { t: `%${term}%` });
  }
}
