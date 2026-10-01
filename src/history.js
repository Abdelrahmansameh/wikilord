import fs from 'node:fs';

/**
 * Lifetime log of everything that happens to cards: opened in a pack, won at auction, recycled,
 * put on sale, sold. One JSON object per line in cards.jsonl (kept across restarts, never pruned).
 */
const FILE = new URL('../cards.jsonl', import.meta.url);

export function cardEvent(type, fields = {}) {
  try {
    fs.appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), type, ...fields }) + '\n');
  } catch {}
}

function readAll() {
  try {
    return fs
      .readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Ids of cards the bot won at auction (these are never sold or recycled). */
export function wonCardIds() {
  return new Set(readAll().filter((e) => e.type === 'won' && e.cardId).map((e) => e.cardId));
}

/** Auctions won since `sinceMs` (for the weekly limits and theme budgets): [{ at, price, theme, cardId, title }]. */
export function winsSince(sinceMs) {
  return readAll()
    .filter((e) => e.type === 'won' && Date.parse(e.at) >= sinceMs)
    .map((e) => ({ at: Date.parse(e.at), price: e.price ?? 0, theme: e.theme ?? null, cardId: e.cardId, title: e.title }));
}

/**
 * Titles of every card the bot has successfully bid on (bids.jsonl goes back to before the card history
 * existed). Used as extra protection so early wins are never sold or recycled either.
 */
export function bidOnTitles() {
  try {
    return new Set(
      fs.readFileSync(new URL('../bids.jsonl', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((r) => r && r.event === undefined && !r.dry && r.status === 200 && r.title)
        .map((r) => r.title),
    );
  } catch {
    return new Set();
  }
}

/** Newest first, optionally filtered by type, a text search on the title, and a start time. */
export function readCardEvents({ limit = 500, type, q, sinceMs } = {}) {
  let rows = readAll();
  if (sinceMs) rows = rows.filter((e) => Date.parse(e.at) >= sinceMs);
  const counts = {};
  const sums = { won: 0, sold: 0, recycled: 0 };
  for (const e of rows) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'won') sums.won += e.price ?? 0;
    if (e.type === 'sold') sums.sold += e.price ?? 0;
    if (e.type === 'recycled') sums.recycled += e.gained ?? 0;
  }
  if (type) rows = rows.filter((e) => e.type === type);
  if (q) {
    const needle = q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    rows = rows.filter((e) => (e.title ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(needle));
  }
  return { events: rows.reverse().slice(0, limit), counts, sums, total: rows.length };
}
