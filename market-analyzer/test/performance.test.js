import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Analysis } from '../src/analysis.js';
import { AnalysisClient } from '../src/analysis-client.js';

/** A fresh database; `first` runs before it is closed and deleted (readers must let go of the file on Windows). */
function tempStore(t, first = async () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-perf-'));
  const store = new Store(path.join(dir, 'market.db'));
  t.after(async () => {
    await first();
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test('a new database gets planner statistics', (t) => {
  const store = tempStore(t);
  assert.ok(store.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'`).get());
  store.optimize();
});

test('timing histograms counted in SQL match bucketing every row', (t) => {
  const store = tempStore(t);
  const now = Date.now();
  // Bids on and around every bucket edge, plus listings of every length, including exact edge values.
  const secs = [0, 0.5, 1, 2.999, 3, 5, 9, 10, 30, 59, 60, 61, 299, 300, 900, 3599, 3600, 10800, 21599, 21600, 90000];
  const hours = [0.5, 0.99, 1, 1.5, 2, 3.995, 4, 6, 11.99, 12, 24, 47.99, 48, 100];
  const insAuction = store.db.prepare(`INSERT INTO auctions (id, card_id, rarity, is_shiny, final, status, final_price,
    base_amount, bid_count, created_at, end_at, last_bid_at) VALUES (?, 'c', 'R', 0, 1, ?, ?, 10, 1, ?, ?, ?)`);
  const insBid = store.db.prepare(`INSERT INTO bids (id, auction_id, bidder_id, amount, placed_at) VALUES (?, ?, 'u', 1, ?)`);
  const end = now - 1000;
  secs.forEach((s, i) => {
    const sold = i % 3 !== 0;
    insAuction.run(`b${i}`, sold ? 'settled_sold' : 'settled_unsold', sold ? 10 + i : null, end - 3600e3, end, end - s * 1000);
    insBid.run(`bid${i}`, `b${i}`, end - s * 1000);
    insBid.run(`bid${i}x`, `b${i}`, end - s * 1000 - 7000);
  });
  hours.forEach((h, i) => {
    const sold = i % 2 === 0;
    insAuction.run(`d${i}`, sold ? 'settled_sold' : 'settled_unsold', sold ? 100 + i : null, end - h * 3600e3, end, null);
  });
  const r = new Analysis(store).timing({ range: 'all' });

  const bidEdges = [1, 3, 5, 10, 30, 60, 300, 900, 3600, 3 * 3600, 6 * 3600, Infinity];
  const bucket = (v, edges, off = 0) => { let i = 0; while (v >= edges[i] - off) i++; return i; };
  const bids = bidEdges.map(() => 0);
  const wins = bidEdges.map(() => 0);
  for (const s of secs) {
    bids[bucket(s, bidEdges)]++;
    bids[bucket(s + 7, bidEdges)]++;
    wins[bucket(s, bidEdges)]++;
  }
  assert.deepEqual(r.bidTiming.map((b) => b.n), bids);
  assert.deepEqual(r.winningBidTiming.map((b) => b.n), wins);
  assert.deepEqual(r.bidTiming.map((b) => b.lt), bidEdges.map((e) => (e === Infinity ? null : e)));

  const durEdges = [1, 2, 4, 6, 12, 24, 48, Infinity];
  const dur = durEdges.map((e) => ({ lt: e === Infinity ? null : e, n: 0, sold: 0, sum: 0 }));
  const listings = [...secs.map((_s, i) => [1, i % 3 !== 0, 10 + i]), ...hours.map((h, i) => [h, i % 2 === 0, 100 + i])];
  for (const [h, sold, p] of listings) {
    const d = dur[bucket(h, durEdges, 0.01)];
    d.n++;
    if (sold) { d.sold++; d.sum += p; }
  }
  assert.deepEqual(r.durations, dur.map((d) => ({ lt: d.lt, n: d.n, sold: d.sold, avg_price: d.sold ? d.sum / d.sold : null })));
});

test('cached views answer at once with the last result and refresh it in the background', async (t) => {
  let client;
  const store = tempStore(t, () => client.close());
  const insert = store.db.prepare(`INSERT INTO auctions (id, card_id, rarity, is_shiny, final, status, final_price, end_at)
    VALUES (?, 'c', 'R', 0, 1, 'settled_sold', 10, ?)`);
  insert.run('a1', Date.now());
  client = new AnalysisClient(store.file);
  await client.start();
  assert.notStrictEqual(client.slotFor('card'), client.slotFor('overview'), 'lookups never queue behind range scans');

  const q = { range: 'all' };
  assert.equal((await client.call('overview', q)).totals.n, 1);
  insert.run('a2', Date.now());
  assert.equal((await client.call('overview', q)).totals.n, 1, 'fresh result reused');
  // Age the cached result past its freshness window: the old value comes back immediately...
  const key = JSON.stringify(['overview', [q]]);
  client.cache.get(key).at -= 61_000;
  assert.equal((await client.call('overview', q)).totals.n, 1);
  // ...while the refresh it started brings in the new auction.
  await client.inflight.get(key);
  assert.equal((await client.call('overview', q)).totals.n, 2);
  // Past the stale limit a request waits for a new answer instead.
  insert.run('a3', Date.now());
  client.cache.get(key).at -= 31 * 60_000;
  assert.equal((await client.call('overview', q)).totals.n, 3);
});
