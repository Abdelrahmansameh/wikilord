/**
 * Real auction results from the market analyzer's database (market-analyzer/market.db), when it exists.
 * Read-only: the analyzer is the only writer. Reading it costs the site nothing, unlike price lookups.
 * Optional: everything else works without it.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MARKET_DB = process.env.WM_MARKET_DB ?? fileURLToPath(new URL('../market-analyzer/market.db', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _db;
async function open() {
  if (_db) return _db;
  if (!fs.existsSync(MARKET_DB)) throw new Error(`no market analyzer database at ${MARKET_DB} (start market-analyzer/start-market.bat to collect one)`);
  // node:sqlite still prints an "experimental" warning on Node 22: keep it out of the output
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/sqlite/i.test(String(w)) ? undefined : emit.call(process, w, ...rest));
  const { DatabaseSync } = await import('node:sqlite');
  _db = new DatabaseSync(MARKET_DB, { readOnly: true });
  return _db;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

/** Card ids for exact titles, from the analyzer's own card table (no site request). Unknown titles are left out. */
export async function idsForTitles(titles) {
  const db = await open();
  const q = db.prepare('SELECT id, title, rarity FROM cards WHERE title = ? COLLATE NOCASE');
  const out = new Map();
  for (const t of titles) {
    const row = q.get(t);
    if (row) out.set(t, row);
  }
  return out;
}

/**
 * Per card: what it really sold for (by rarity, shiny apart), how often listings went unsold and at what start
 * price, and what is on sale right now. `days` limits how far back to look (default: everything recorded).
 */
export async function salesFor(cardIds, { days } = {}) {
  const db = await open();
  const ids = cardIds.filter((id) => UUID.test(id));
  if (!ids.length) return [];
  const since = days ? Date.now() - days * 86400_000 : 0;
  const now = Date.now();
  const marks = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT card_id, title, rarity, is_shiny, status, final_price, base_amount, listing_base_amount, bid_count, end_at, final,
              COALESCE(effective_bid, current_bid, base_amount) AS price_now
       FROM auctions WHERE card_id IN (${marks}) AND (end_at >= ? OR final = 0)`,
    )
    .all(...ids, since);
  const span = db.prepare('SELECT MIN(end_at) AS a FROM auctions WHERE final = 1').get();
  return ids.map((id) => {
    const mine = rows.filter((r) => r.card_id === id);
    const sold = mine.filter((r) => r.final === 1 && r.status === 'settled_sold' && r.final_price != null);
    const unsold = mine.filter((r) => r.final === 1 && r.status === 'settled_unsold');
    const live = mine.filter((r) => r.final === 0 && r.end_at > now).sort((a, b) => a.price_now - b.price_now);
    const groups = {};
    for (const r of sold) (groups[`${r.rarity}${r.is_shiny ? '★' : ''}`] ??= []).push(r);
    const soldBy = Object.fromEntries(
      Object.entries(groups).map(([k, g]) => {
        const p = g.map((r) => r.final_price).sort((a, b) => a - b);
        const recent = [...g].sort((a, b) => b.end_at - a.end_at).slice(0, 3).map((r) => r.final_price);
        return [k, { n: p.length, min: p[0], p25: pct(p, 0.25), median: pct(p, 0.5), p75: pct(p, 0.75), max: p.at(-1), recent }];
      }),
    );
    const unsoldStarts = unsold.map((r) => r.listing_base_amount ?? r.base_amount).filter((x) => x != null).sort((a, b) => a - b);
    return {
      cardId: id,
      title: mine[0]?.title ?? null,
      sold: soldBy,
      unsold: unsold.length ? { n: unsold.length, medianStartPrice: pct(unsoldStarts, 0.5) } : null,
      onSaleNow: live.length ? { n: live.length, cheapest: live[0].price_now, cheapestRarity: live[0].rarity + (live[0].is_shiny ? '★' : '') } : null,
      recordedSince: span?.a ? new Date(span.a).toISOString() : null,
    };
  });
}
