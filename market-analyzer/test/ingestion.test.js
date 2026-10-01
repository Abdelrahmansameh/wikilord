import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Collector } from '../src/collector.js';
import { AccountPool } from '../src/accounts.js';
import { Analysis } from '../src/analysis.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-ingest-'));
  const store = new Store(path.join(dir, 'test.db'));
  return { store, close() { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const now = Date.now();
const listing = (id, created = now, end = now + 600_000) => ({
  id, card_id: 'card-1', seller_id: 'seller-1', status: 'active', created_at: new Date(created).toISOString(),
  end_at: new Date(end).toISOString(), base_amount: 100, card: { id: 'card-1', wikipedia_title: 'Test card', rarity: 'C', category: 'Test' },
  seller: { id: 'seller-1', username: 'Seller' },
});
const detail = (a) => ({ auction: { ...a, status: 'settled_sold', final_price: 200, winner_id: 'buyer-1',
  settled_at: new Date(now + 600_000).toISOString() }, bids: [{ id: 'bid-1', bidder_id: 'buyer-1', amount: 200,
    placed_at: new Date(now + 300_000).toISOString() }] });

test('recent and ending feeds merge atomically; final detail is idempotent', () => {
  const f = fixture();
  try {
    const a = listing('auction-1');
    assert.equal(f.store.saveSnapshots([a], 'recent').fresh, 1);
    assert.equal(f.store.saveSnapshots([a], 'ending').fresh, 0);
    assert.equal(f.store.saveResult(detail(a), false, 'primary').stored, true);
    assert.equal(f.store.saveResult(detail(a), false, 'secondary').duplicate, true);
    f.store.saveSnapshots([{ ...a, status: 'active', current_bid: 900 }], 'recent');
    assert.deepEqual({ ...f.store.db.prepare('SELECT COUNT(*) n, SUM(final) finals, MAX(final_price) price, MAX(current_bid) bid FROM auctions').get() },
      { n: 1, finals: 1, price: 200, bid: null });
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM bids').get().n, 1);
    assert.deepEqual({ ...f.store.db.prepare('SELECT times_sold, times_listed FROM cards WHERE id = ?').get('card-1') },
      { times_sold: 1, times_listed: 1 });
    assert.deepEqual({ ...f.store.ingestionInfo() }, { recent_seen: 1, ending_seen: 1, overlap: 1, conflicts: 0 });
  } finally { f.close(); }
});

test('same ID with different identity or result is quarantined', () => {
  const f = fixture();
  try {
    const a = listing('auction-1');
    f.store.saveSnapshots([a], 'recent');
    assert.equal(f.store.saveSnapshots([{ ...a, card_id: 'other' }], 'ending').conflicts, 1);
    f.store.saveResult(detail(a), false, 'primary');
    assert.equal(f.store.saveResult({ ...detail(a), auction: { ...detail(a).auction, final_price: 999 } }, false, 'secondary').conflict, true);
    assert.equal(f.store.db.prepare('SELECT final_price FROM auctions WHERE id = ?').get(a.id).final_price, 200);
    assert.equal(f.store.ingestionInfo().conflicts, 1);
  } finally { f.close(); }
});

test('Browse shows new listings once and moves them to results after settlement', () => {
  const f = fixture();
  try {
    const a = listing('auction-1');
    f.store.saveSnapshots([a], 'recent');
    f.store.saveSnapshots([a], 'ending');
    const analysis = new Analysis(f.store);
    assert.equal(analysis.auctions({ status: 'active', range: '24h' }).rows.length, 1);
    assert.equal(analysis.auctions({ range: '24h' }).rows.length, 0);
    f.store.saveResult(detail(a), false);
    assert.equal(analysis.auctions({ status: 'active', range: '24h' }).rows.length, 0);
    assert.equal(analysis.auctions({ range: '24h' }).rows.length, 1);
  } finally { f.close(); }
});

test('cancelled listings become one final record without inflating sale counts', () => {
  const f = fixture();
  try {
    const a = listing('cancelled-1');
    f.store.saveSnapshots([a], 'recent');
    const cancelled = { auction: { ...a, status: 'cancelled' }, bids: [] };
    assert.equal(f.store.saveResult(cancelled, false).stored, true);
    assert.equal(f.store.saveResult(cancelled, false).duplicate, true);
    assert.equal(f.store.db.prepare('SELECT final FROM auctions WHERE id = ?').get(a.id).final, 1);
    assert.equal(new Analysis(f.store).auctions({ status: 'cancelled', range: '24h' }).rows.length, 1);
    assert.equal(f.store.db.prepare('SELECT times_sold FROM cards WHERE id = ?').get(a.card_id).times_sold, 0);
  } finally { f.close(); }
});

test('recent pagination catches up across bounded cycles without repeating IDs', async () => {
  const f = fixture();
  try {
    const rows = Array.from({ length: 180 }, (_, i) => listing(`a-${i}`, now - i * 1000));
    const pool = { activeCount: 1, waiting: 0, slowedDown: false, status: () => [],
      async request(url) { const page = Number(new URL(url, 'http://x').searchParams.get('page'));
        return { status: 200, account: 'primary', json: { auctions: rows.slice((page - 1) * 50, page * 50), hasMore: page * 50 < rows.length } }; } };
    const cfg = { recentInitialLookbackSec: 175, recentOverlapSec: 5, maxRecentPagesPerCycle: 3,
      pendingHorizonSec: 120, settleDelayMs: 2500 };
    const c = new Collector(f.store, pool, cfg, () => {});
    await c.sweepRecent();
    assert.equal(c.lastRecentSweep.complete, false);
    const resumed = new Collector(f.store, pool, cfg, () => {});
    assert.equal(resumed.recentCursor.page, 4);
    await resumed.sweepRecent();
    assert.equal(resumed.lastRecentSweep.complete, true);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM auctions').get().n, 180);
    assert.equal(f.store.ingestionInfo().recent_seen, 180);
    assert.ok(Number(f.store.getMeta('recent_watermark_ms')) >= now - 1000);
  } finally { f.close(); }
});

test('more than one new page during catch-up leaves no gap', async () => {
  const f = fixture();
  try {
    let rows = Array.from({ length: 180 }, (_, i) => listing(`old-${i}`, now - 60_000 - i * 1000));
    const pool = { activeCount: 1, waiting: 0, slowedDown: false, status: () => [],
      async request(url) { const page = Number(new URL(url, 'http://x').searchParams.get('page'));
        return { status: 200, account: 'primary', json: { auctions: rows.slice((page - 1) * 50, page * 50), hasMore: page * 50 < rows.length } }; } };
    const cfg = { recentInitialLookbackSec: 300, recentOverlapSec: 5, maxRecentPagesPerCycle: 3,
      pendingHorizonSec: 120, settleDelayMs: 2500 };
    let c = new Collector(f.store, pool, cfg, () => {});
    await c.sweepRecent();
    assert.equal(c.lastRecentSweep.complete, false);
    rows = [...Array.from({ length: 60 }, (_, i) => listing(`new-${i}`, now - i * 1000)), ...rows];
    c = new Collector(f.store, pool, cfg, () => {}); // a restart between catch-up cycles
    for (let i = 0; i < 6 && !c.lastRecentSweep?.complete; i++) await c.sweepRecent();
    assert.equal(c.lastRecentSweep.complete, true);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM auctions').get().n, 240);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM auctions WHERE id LIKE 'new-%'").get().n, 60);
  } finally { f.close(); }
});

test('temporary missing detail remains pending after many retries', async () => {
  const f = fixture();
  try {
    const a = listing('missing-1', now - 600_000, now - 1000);
    f.store.saveSnapshots([a], 'ending');
    const pool = { activeCount: 1, waiting: 0, slowedDown: false, status: () => [],
      async request() { return { status: 404, account: 'primary' }; } };
    const c = new Collector(f.store, pool, { recentInitialLookbackSec: 120, pendingHorizonSec: 120,
      settleDelayMs: 2500, maxInflight: 40 }, () => {});
    c.refreshPending();
    const p = c.pending.get(a.id);
    for (let i = 0; i < 15; i++) await c.settle(a.id, p);
    assert.ok(c.pending.has(a.id));
    assert.equal(f.store.pending(Date.now()).length, 1);
    assert.equal(f.store.db.prepare('SELECT final FROM auctions WHERE id = ?').get(a.id).final, 0);
  } finally { f.close(); }
});

test('distinct accounts both handle requests; duplicate account is blocked', async () => {
  const mk = (id) => ({ hasCookie: () => true, userId: () => id, username: () => id,
    request: async () => ({ status: 200, json: { auctions: [] } }) });
  const pool = new AccountPool([mk('one'), mk('two')], { maxRps: 100 }, () => {});
  const replies = await Promise.all(Array.from({ length: 10 }, () => pool.request('/api/marketplace', 1)));
  assert.ok(replies.some((r) => r.account === 'primary'));
  assert.ok(replies.some((r) => r.account === 'secondary'));
  const duplicate = new AccountPool([mk('one'), mk('one')], { maxRps: 100 }, () => {});
  assert.equal(duplicate.activeCount, 1);
});

test('recent pages get request slots while result backlog is full', async () => {
  const session = { hasCookie: () => true, userId: () => 'one', username: () => 'one',
    request: async (_method, path) => ({ status: 200, json: { path } }) };
  const empty = { hasCookie: () => false, userId: () => null, username: () => null };
  const pool = new AccountPool([session, empty], { maxRps: 100 }, () => {});
  const order = [];
  const backlog = Array.from({ length: 30 }, (_, i) => pool.request(`/detail/${i}`, 1).then(() => order.push('detail')));
  const recent = pool.request('/recent', 2).then(() => order.push('recent'));
  await Promise.all([...backlog, recent]);
  assert.ok(order.indexOf('recent') < 20, `recent page was slot ${order.indexOf('recent')}`);
});

test('expired account fails over to the other account without duplicating work', async () => {
  const primary = { hasCookie: () => true, userId: () => 'one', username: () => 'one',
    request: async () => ({ status: 401 }) };
  const secondary = { hasCookie: () => true, userId: () => 'two', username: () => 'two',
    request: async () => ({ status: 200, json: { auctions: [] } }) };
  const pool = new AccountPool([primary, secondary], { maxRps: 100 }, () => {});
  const response = await pool.request('/api/marketplace', 0);
  assert.equal(response.account, 'secondary');
  assert.equal(pool.status()[0].needsLogin, true);
  assert.equal(pool.activeCount, 1);
});
