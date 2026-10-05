import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Store } from '../src/db.js';
import { Analysis } from '../src/analysis.js';
import { AnalysisClient } from '../src/analysis-client.js';
import { startServer } from '../src/server.js';

const plain = (value) => JSON.parse(JSON.stringify(value));

async function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-worker-'));
  const file = path.join(dir, 'market.db');
  const store = new Store(file);
  const now = Date.now();
  const auction = { id: 'auction-1', card_id: 'card-1', seller_id: 'seller-1', status: 'active',
    created_at: new Date(now - 720_000).toISOString(), end_at: new Date(now - 120_000).toISOString(),
    base_amount: 10, card: { id: 'card-1', wikipedia_title: 'Test card', rarity: 'R', is_shiny: false,
      q_score: 50, atk: 10, def: 20, category: 'France', pageviews: 100 },
    seller: { id: 'seller-1', username: 'Seller' } };
  store.saveSnapshots([auction], 'recent');
  store.saveResult({ auction: { ...auction, status: 'settled_sold', final_price: 30, winner_id: 'buyer-1',
    winner: { id: 'buyer-1', username: 'Buyer' }, settled_at: new Date(now - 120_000).toISOString() },
  bids: [{ id: 'bid-1', bidder_id: 'buyer-1', amount: 30, placed_at: new Date(now - 125_000).toISOString() }] }, true);
  const client = new AnalysisClient(file, options);
  t.after(async () => {
    await client.close();
    store.db.close();
    // Only this test's own freshly created temporary directory is removed.
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await client.start();
  return { store, client, direct: new Analysis(store) };
}

async function serverFixture(t, client) {
  const server = startServer({ cfg: { port: 0 }, analysis: client,
    collector: { status: () => ({ running: true }) },
    pool: { accounts: [{ session: { username: () => 'test' } }], activeCount: 1, status: () => [] }, log: () => {} });
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (route) => {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    return response.json();
  };
}

test('worker preserves all dashboard results, combined responses, raw data and missing-record fallbacks', async (t) => {
  const { client, direct, store } = await fixture(t);
  const get = await serverFixture(t, client);
  const q = { range: 'all', tz: '240' };
  const queries = [
    ['overview', 'overview'], ['turnover', 'turnover'], ['scatter', 'scatter'], ['timing', 'timing'],
    ['players', 'players'], ['auctions', 'auctions'], ['category-groups', 'categoryGroups'],
  ];
  for (const [route, method] of queries) {
    assert.deepEqual(await get(`/api/${route}?range=all&tz=240`), plain(direct[method](q)), route);
  }
  assert.deepEqual(await get('/api/auction-appearances?range=all'), plain(direct.auctionAppearances({ range: 'all' })));
  const group = direct.categoryGroups(q).groups[0];
  assert.ok(group);
  assert.deepEqual(await get(`/api/category-detail?range=all&tz=240&g=${encodeURIComponent(group.g)}`),
    plain(direct.categoryDetail({ ...q, g: group.g })));
  assert.deepEqual(await get('/api/prices?range=all&tz=240'),
    plain({ groups: direct.prices(q), start: direct.startingPrice(q) }));
  for (const [route, expected] of [
    ['/api/auction?id=auction-1', direct.auction('auction-1')],
    ['/api/cards?q=Test', direct.cards('Test')],
    ['/api/cards?q=', direct.cards('')],
    ['/api/card-rankings?sort=median', direct.cardRankings('median')],
    ['/api/card?id=card-1&page=1', direct.card('card-1', '1')],
    ['/api/raw?id=auction-1', store.raw('auction-1')],
    ['/api/comparable?rarity=R&shiny=0&q_score=50', direct.comparable({ rarity: 'R', shiny: '0', q_score: '50' })],
    ['/api/users?q=Buy', direct.users('Buy')],
    ['/api/auction?id=missing', { error: 'not found' }],
    ['/api/card?id=missing', { error: 'card not found' }],
    ['/api/raw?id=missing', { error: 'no raw copy stored' }],
  ]) assert.deepEqual(await get(route), plain(expected), route);
  const status = await get('/api/status');
  assert.deepEqual(status.db, plain(direct.dbInfo()));
  assert.deepEqual(status.ingestion, plain(store.ingestionInfo()));
  assert.equal(status.hasCookie, true);
  assert.equal(status.collector.running, true);
  // Neither arbitrary SQL nor inherited/internal methods can be invoked through the worker.
  await assert.rejects(client.call('all', 'DELETE FROM auctions'), /Unknown analysis method/);
  await assert.rejects(client.call('constructor'), /Unknown analysis method/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM auctions').get().n, 1);
});

test('worker sees committed WAL writes, coalesces duplicate requests and survives query errors', async (t) => {
  const { client, store } = await fixture(t);
  const first = client.call('auctions', { range: 'all' });
  assert.strictEqual(client.call('auctions', { range: 'all' }), first);
  assert.equal((await first).rows.length, 1);
  store.db.prepare("UPDATE auctions SET final_price = 99 WHERE id = 'auction-1'").run();
  assert.equal((await client.call('auctions', { range: 'all' })).rows[0].final_price, 99);
  await assert.rejects(client.call('comparable', {}));
  assert.equal((await client.call('auction', 'auction-1')).auction.final_price, 99);
});

test('worker exits reject pending calls and the next request starts a healthy replacement', async (t) => {
  const { client } = await fixture(t);
  const slot = client.slotFor('overview');
  await slot.run('overview', [{ range: 'all' }]);
  const oldWorker = slot.worker;
  // These requests wait for the old worker to terminate, so cannot finish before it exits.
  slot.stopping = oldWorker.terminate();
  const pending = client.call('overview', { range: 'all' });
  await assert.rejects(pending, /exited/);
  assert.equal((await client.call('overview', { range: 'all' })).totals.n, 1);
  assert.notStrictEqual(slot.worker, oldWorker);
  await client.refreshStatus();
  assert.equal(client.status().error, null);
  await client.close();
  await assert.rejects(client.call('overview', { range: 'all' }), /closed/);
});

test('pending work is bounded and closing rejects requests waiting for dispatch', async (t) => {
  const { client } = await fixture(t, { maxPending: 1 });
  const first = client.call('overview', { range: 'all' });
  await assert.rejects(client.call('players', { range: 'all' }), /busy/);
  await first;
  const pending = client.call('overview', { range: '24h' });
  const rejected = assert.rejects(pending, /closed/);
  await client.close();
  await rejected;
});

test('timeout rejects work and a subsequent request recovers', async (t) => {
  const { client } = await fixture(t);
  await client.slotFor('overview').run('overview', [{ range: 'all' }]);
  await client.slotFor('overview').worker.terminate();
  // A new worker cannot open and read the database within this startup deadline.
  client.timeoutMs = 1;
  await assert.rejects(client.call('overview', { range: 'all' }), /timed out/);
  client.timeoutMs = 120_000;
  assert.equal((await client.call('overview', { range: 'all' })).totals.n, 1);
});

test('a missing database fails without creating it or running writer migrations', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-worker-missing-'));
  const file = path.join(dir, 'missing.db');
  const client = new AnalysisClient(file);
  t.after(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(client.start(), /unable to open database/);
  assert.equal(fs.existsSync(file), false);
});

test('large historical analysis leaves HTTP status, main-thread timers and database writes responsive', async (t) => {
  const { client, store } = await fixture(t);
  const get = await serverFixture(t, client);
  const now = Date.now();
  store.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 60000)
    INSERT INTO auctions (id, card_id, category, rarity, is_shiny, final, status, final_price, base_amount,
      bid_count, bidder_count, seller_id, winner_id, created_at, end_at, last_bid_at)
    SELECT 'bulk-' || x, 'card-' || (x % 100), 'France', 'R', 0, 1, 'settled_sold', x % 1000 + 1, 10,
      1, 1, 'seller-1', 'buyer-1', $now - 720000, $now - (x * 100), $now - (x * 100) - 5000 FROM n`).run({ now });
  let finished = false;
  const work = client.call('categoryGroups', { range: 'all', mode: 'exact' }).finally(() => { finished = true; });
  const status = await get('/api/status');
  assert.equal(finished, false, 'status returns while historical analysis is still running');
  assert.ok(status.analysis.pending > 0);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  try {
    // A collector-style write can commit even while the worker reads the same WAL database.
    store.db.prepare("UPDATE auctions SET final_price = 101 WHERE id = 'auction-1'").run();
    assert.ok((await work).groups.length > 0);
    assert.ok(ticks > 0, 'collector timers run during the analysis query');
    assert.equal((await client.call('auction', 'auction-1')).auction.final_price, 101);
  } finally { clearInterval(timer); }
});
