import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Analysis } from '../src/analysis.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-queries-'));
  const store = new Store(path.join(dir, 'test.db'));
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const now = Date.now();
  const insert = store.db.prepare(`INSERT INTO auctions
    (id, card_id, title, category, rarity, is_shiny, status, final, final_price, base_amount,
     bid_count, bidder_count, created_at, end_at, first_seen, seller_id, winner_id, last_bid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, 'seller', 'buyer', ?)`);
  let next = 0;
  const sale = (price, { category = 'A', rarity = 'R', shiny = 0, card = 'card-a', status = 'settled_sold', final = 1 } = {}) => {
    const id = `auction-${++next}`;
    const end = now - (1000 - next) * 1000;
    insert.run(id, card, 'Card', category, rarity, shiny, status, final, price, end - 3600e3, end, end - 3600e3, end - 1000);
    return id;
  };
  store.db.exec(`INSERT INTO users (id,username) VALUES ('seller','Seller'),('buyer','Buyer');
    INSERT INTO cards (id,title,rarity,is_shiny,q_score,times_sold,times_listed) VALUES ('card-a','Card','R',0,50,0,0);`);
  return { store, analysis: new Analysis(store), sale };
}

test('frequency aggregates preserve exact price quantiles, histograms and filters', (t) => {
  const { analysis, sale } = setup(t);
  [1, 10, 10, 10, 10, 10, 101, 101, 1001, 1001].forEach((p) => sale(p));
  sale(null, { status: 'settled_unsold' });
  sale(999, { rarity: 'UR', shiny: 1 });
  sale(50, { status: 'active', final: 0 });
  const [r] = analysis.prices({ range: 'all', rarity: 'R', shiny: '0' });
  assert.deepEqual({ n: r.n, sold: r.sold, min: r.min, p10: r.p10, p25: r.p25,
    median: r.median, p75: r.p75, p90: r.p90, max: r.max },
    { n: 11, sold: 10, min: 1, p10: 9.1, p25: 10, median: 10, p75: 101, p90: 1001, max: 1001 });
  assert.deepEqual(r.histogram.filter((b) => b.n), [
    { lt: 2, n: 1 }, { lt: 20, n: 5 }, { lt: 200, n: 2 }, { lt: 2000, n: 2 },
  ]);
  assert.deepEqual(analysis.comparable({ rarity: 'R', shiny: 0 }), {
    n: 11, sold: 10, min: 1, p10: 9.1, p25: 10, median: 10, p75: 101, p90: 1001, max: 1001,
  });
  assert.equal(analysis.prices({ range: 'all', rarity: 'UR', shiny: '1' })[0].median, 999);
});

test('category medians and distinct cards remain exact across tags and repeated prices', (t) => {
  const { store, analysis, sale } = setup(t);
  store.db.exec(`INSERT INTO category_tags (category,kind,tag,label) VALUES
    ('A','theme','shared','Shared'),('B','theme','shared','Shared'),('A','theme','a','A only'),('B','theme','b','B only');`);
  [10, 10, 10].forEach((p) => sale(p, { category: 'A', card: 'same-card' }));
  [20, 20, 20].forEach((p) => sale(p, { category: 'B', card: 'same-card' }));
  sale(null, { category: 'B', card: 'never-sold', status: 'settled_unsold' });
  const r = analysis.categoryGroups({ range: 'all', mode: 'theme' });
  const shared = r.groups.find((g) => g.g === 'shared');
  assert.equal(r.total, 7);
  assert.equal(shared.n, 7);
  assert.equal(shared.cards, 2);
  assert.equal(shared.median, 15);
  assert.equal(shared.resold, 1);
  assert.equal(shared.mix.R, 7);
  assert.equal(shared.sell_through, 6 / 7);
  assert.equal(r.groups.find((g) => g.g === 'a').median, 10);
  assert.equal(r.groups.find((g) => g.g === 'b').median, 20);
  assert.deepEqual(analysis.categoryGroups({ range: 'all', mode: 'theme', shiny: '1' }).groups, []);
});

test('card charts fetch a bounded history while lifetime price statistics include old sales', (t) => {
  const { analysis, sale } = setup(t);
  for (let i = 1; i <= 230; i++) sale(i);
  const r = analysis.card('card-a');
  assert.equal(r.stats.sold, 230);
  assert.equal(r.stats.volume, 230 * 231 / 2);
  assert.equal(r.stats.median, 115.5);
  assert.equal(r.stats.min, 1);
  assert.equal(r.stats.max, 230);
  assert.equal(r.stats.recent_median, 228);
  assert.equal(r.stats.last_sale_price, 230);
  assert.equal(r.priceHistory.length, 200);
  assert.equal(r.priceHistory[0].price, 31);
  assert.equal(r.priceHistory.at(-1).price, 230);
  assert.equal(r.priceHistoryTruncated, true);
  assert.equal(r.history.rows.length, 50);
  assert.equal(r.history.hasMore, true);
});

test('listing pages apply limits and sorting before attaching names and card metrics', (t) => {
  const { store, analysis, sale } = setup(t);
  for (let i = 1; i <= 60; i++) sale(i);
  store.db.exec(`UPDATE cards SET times_sold=60,times_listed=60 WHERE id='card-a'`);
  const r = analysis.auctions({ range: 'all', sort: 'price', limit: 15, page: '1.9' });
  assert.equal(r.rows.length, 15);
  assert.equal(r.page, 1);
  assert.equal(r.hasMore, true);
  assert.equal(r.rows[0].final_price, 60);
  assert.equal(r.rows.at(-1).final_price, 46);
  assert.equal(r.rows[0].winner, 'Buyer');
  assert.equal(r.rows[0].seller, 'Seller');
  assert.equal(r.rows[0].times_sold, 60);
  assert.equal(analysis.auctions({ range: 'all', sort: 'resold' }).rows.length, 50);
});

test('player aggregation retains user filtering and wins from the final bid', (t) => {
  const { store, analysis, sale } = setup(t);
  const first = sale(10);
  sale(20);
  sale(null, { status: 'settled_unsold' });
  const end = store.db.prepare('SELECT end_at FROM auctions WHERE id=?').get(first).end_at;
  const bid = store.db.prepare('INSERT INTO bids (id,auction_id,bidder_id,amount,placed_at) VALUES (?,?,?,?,?)');
  bid.run('b1', first, 'buyer', 5, end - 60_000);
  bid.run('b2', first, 'buyer', 10, end - 1000);
  const r = analysis.players({ range: 'all' });
  assert.equal(r.buyers[0].won, 2);
  assert.equal(r.buyers[0].spent, 30);
  assert.equal(r.sellers[0].listed, 3);
  assert.equal(r.sellers[0].sold, 2);
  assert.equal(r.bidders[0].bids, 2);
  assert.equal(r.bidders[0].auctions, 1);
  assert.equal(r.bidders[0].wins, 1);
  assert.equal(r.bidders[0].late_bids, 1);
  assert.deepEqual(analysis.players({ range: 'all', player: 'Buy' }).sellers, []);
  assert.deepEqual(analysis.players({ range: 'all', player: 'Sel' }).buyers, []);
});

test('ordered bid joins retain auction range, rarity, shiny and settlement filters', (t) => {
  const { store, analysis, sale } = setup(t);
  const ids = [sale(10), sale(null, { status: 'settled_unsold' }), sale(20, { shiny: 1 }),
    sale(30, { rarity: 'UR' }), sale(null, { status: 'active', final: 0 }),
    sale(null, { status: 'cancelled' }), sale(40)];
  store.db.prepare('UPDATE auctions SET end_at=?,last_bid_at=? WHERE id=?')
    .run(Date.now() - 48 * 3600e3, Date.now() - 48 * 3600e3 - 1000, ids.at(-1));
  const insert = store.db.prepare('INSERT INTO bids (id,auction_id,bidder_id,amount,placed_at) VALUES (?,?,?,?,?)');
  for (const id of ids) {
    const end = store.db.prepare('SELECT end_at FROM auctions WHERE id=?').get(id).end_at;
    insert.run(`bid-${id}`, id, 'buyer', 10, end - 1000);
  }
  const q = { range: '24h', rarity: 'R', shiny: '0' };
  const timing = analysis.timing(q);
  assert.equal(timing.bidTiming.reduce((sum, b) => sum + b.n, 0), 2);
  assert.equal(timing.winningBidTiming.reduce((sum, b) => sum + b.n, 0), 2);
  assert.equal(analysis.players(q).bidders[0].bids, 2);
  assert.equal(analysis.players({ ...q, player: 'Buy' }).bidders[0].bids, 2);
  assert.equal(analysis.players(q).buyers[0].won, 1);
  assert.equal(analysis.players(q).sellers[0].listed, 2);
});

test('category metrics retain nullable averages in every grouping mode and filtered range', (t) => {
  const { store, analysis, sale } = setup(t);
  const now = Date.now();
  const tag = store.db.prepare('INSERT INTO category_tags (category,kind,tag,label) VALUES (?,?,?,?)');
  for (const kind of ['theme', 'country', 'word'])
    for (const category of ['A', 'B']) tag.run(category, kind, 'shared', 'Shared');
  const update = store.db.prepare(`UPDATE auctions SET end_at=?,last_bid_at=?,q_score=?,pageviews=?,bid_count=?,bidder_count=? WHERE id=?`);
  for (let i = 0; i < 6; i++) {
    const a = sale(10, { category: 'A' });
    update.run(now - 20 * 3600e3 + i * 1000, null, null, null, null, null, a);
    const b = sale(100, { category: 'B', rarity: 'SR', shiny: 1 });
    const end = now - 2 * 3600e3 + i * 1000;
    update.run(end, end - 30_000, 100, 1000, 3, 2, b);
  }
  sale(null, { category: 'A', status: 'settled_unsold' });
  for (const mode of ['theme', 'country', 'word']) {
    for (const range of ['24h', '7d', 'all']) {
      const r = analysis.categoryGroups({ range, mode }).groups[0];
      assert.equal(r.n, 13);
      assert.equal(r.sold, 12);
      assert.equal(r.volume, 660);
      assert.equal(r.avg_price, 55);
      assert.equal(r.median, 55);
      assert.equal(r.avg_q, 100);
      assert.equal(r.avg_pv, 1000);
      assert.equal(r.avg_bids, 19 / 7);
      assert.equal(r.avg_bidders, 13 / 7);
      assert.equal(r.one_bid, 0);
      assert.equal(r.snipe, 1);
      assert.equal(r.n1, 6);
      assert.equal(r.n2, 7);
      assert.ok(Math.abs(r.price_index - 1) < 1e-12);
      assert.ok(Math.abs(r.price_trend) < 1e-12);
      assert.deepEqual(r.mix, { R: 7, SR: 6 });
    }
    assert.equal(analysis.categoryGroups({ range: '1h', mode }).groups[0].sold, 0);
    const plain = analysis.categoryGroups({ range: 'all', mode, rarity: 'R', shiny: '0' }).groups[0];
    assert.equal(plain.n, 7);
    assert.equal(plain.avg_q, null);
    assert.equal(plain.snipe, null);
    assert.equal(plain.median, 10);
    assert.equal(analysis.categoryGroups({ range: 'all', mode, shiny: '1' }).groups[0].median, 100);
  }
  for (const range of ['24h', '7d', 'all']) {
    const exact = analysis.categoryGroups({ range, mode: 'exact' });
    assert.deepEqual(exact.groups.map((r) => [r.g, r.n, r.sold, r.median, r.avg_q]),
      [['A', 7, 6, 10, null], ['B', 6, 6, 100, 100]]);
  }
  assert.equal(analysis.categoryGroups({ range: 'all', mode: 'theme', min: 14 }).groups.length, 0);
});
