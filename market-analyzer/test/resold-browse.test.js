import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Analysis } from '../src/analysis.js';

test('resold pages bound eligible cards while preserving ties, pagination and every auction filter', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-resold-'));
  const store = new Store(path.join(dir, 'test.db'));
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const now = Date.now();
  const cards = store.db.prepare('INSERT INTO cards (id, title, times_sold, times_listed) VALUES (?, ?, ?, ?)');
  const auctions = store.db.prepare(`INSERT INTO auctions (id, card_id, title, category, search_doc,
    final, status, end_at, created_at, rarity, is_shiny, final_price, base_amount, seller_id, winner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 20, ?, ?)`);
  store.tx(() => {
    cards.run('no-matches', 'No matching auctions', 99, 99);
    for (let c = 0; c < 10; c++) {
      const id = `card-${c}`;
      cards.run(id, `Card ${c}`, c < 2 ? 20 : c < 5 ? 10 : 5, 30);
      for (let a = 0; a < 4; a++) {
        const status = a === 0 ? 'active' : a === 1 ? 'cancelled' : a === 2 ? 'settled_unsold' : 'settled_sold';
        const end = now - (c * 7 + a + (c % 3 === 0 ? 2400 : 0)) * 60_000;
        auctions.run(`${id}-a${a}`, id, c % 2 ? 'Special card' : 'Ordinary', c % 2 ? 'B' : 'A',
          c % 2 ? 'hidden search phrase' : '', a === 0 ? 0 : 1, status, end, now - c * 60_000,
          c % 2 ? 'UR' : 'R', c % 2, a === 3 ? 50 + c : null, c % 2 ? 'seller-b' : 'seller-a',
          a === 3 ? (c % 2 ? 'buyer-b' : 'buyer-a') : null);
      }
    }
    store.db.exec(`INSERT INTO category_tags (category,kind,tag,label) VALUES ('B','theme','special','Special')`);
  });
  const analysis = new Analysis(store);
  const variants = [
    {}, { rarity: 'UR', clause: "a.rarity = 'UR'" }, { rarity: 'R,UR', clause: "a.rarity IN ('R','UR')" },
    { shiny: '1', clause: 'a.is_shiny = 1' }, { q: 'Special', clause: "a.title LIKE '%Special%'" },
    { q: 'hidden search', clause: "a.search_doc LIKE '%hidden search%'" },
    { minPrice: '55', clause: 'a.final_price >= 55' },
    { user: 'seller-b', clause: "(a.seller_id = 'seller-b' OR a.winner_id = 'seller-b')" },
    { user: 'buyer-a', clause: "(a.seller_id = 'buyer-a' OR a.winner_id = 'buyer-a')" },
    { tag: 'B', tagKind: 'exact', clause: "a.category = 'B'" },
    { tag: 'special', tagKind: 'theme', clause: "a.category IN (SELECT category FROM category_tags WHERE kind='theme' AND tag='special')" },
    { card: 'card-2', clause: "a.card_id = 'card-2'" },
    { range: '24h', clause: `a.end_at >= ${now - 86400_000}` },
    { status: 'sold', clause: "a.status = 'settled_sold'" },
    { status: 'unsold', clause: "a.status = 'settled_unsold'" },
    { status: 'cancelled' }, { status: 'active' },
  ];
  for (const variant of variants) {
    const { clause, ...q } = variant;
    const active = q.status === 'active';
    const status = active ? "a.final = 0 AND a.status = 'active'" : q.status === 'cancelled' ?
      "a.final = 1 AND a.status = 'cancelled'" : "a.final = 1 AND a.status IN ('settled_sold','settled_unsold')";
    const order = active ? 'c.times_sold DESC, a.created_at DESC' : 'c.times_sold DESC, a.card_id, a.end_at DESC';
    const expected = store.db.prepare(`SELECT a.id FROM auctions a JOIN cards c ON c.id = a.card_id
      WHERE ${status} AND c.times_sold >= 2 ${clause ? `AND ${clause}` : ''} ORDER BY ${order}`).all().map(row => row.id);
    for (const page of [1, 2, 3, 8]) {
      const result = analysis.auctions({ range: 'all', ...q, sort: 'resold', limit: 2, page });
      assert.deepEqual(result.rows.map(row => row.id), expected.slice((page - 1) * 2, page * 2), JSON.stringify({ q, page }));
      assert.equal(result.hasMore, expected.length > page * 2, JSON.stringify({ q, page }));
    }
  }
  let sql;
  const all = analysis.all.bind(analysis);
  analysis.all = (query, params) => { sql = query; return all(query, params); };
  analysis.auctions({ range: 'all', sort: 'resold', limit: 2, page: 2 });
  assert.match(sql, /eligible AS MATERIALIZED/);
  assert.match(sql, /c\.times_sold DESC, c\.id LIMIT 5/);
  assert.match(sql, /eligible c CROSS JOIN auctions a/);
  analysis.auctions({ range: 'all', sort: 'resold', status: 'active', limit: 2 });
  assert.doesNotMatch(sql, /eligible AS MATERIALIZED/, 'active listings retain global creation-time ties');
});
