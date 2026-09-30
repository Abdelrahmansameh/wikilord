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

/** Newest first, optionally filtered by type and a text search on the title. */
export function readCardEvents({ limit = 500, type, q } = {}) {
  let rows = readAll();
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
