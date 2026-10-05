import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { AnalysisClient } from '../src/analysis-client.js';

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-scheduling-'));
  const store = new Store(path.join(dir, 'market.db'));
  const client = new AnalysisClient(store.file, options);
  t.after(async () => {
    await client.close();
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { client, store };
}

test('browse and rankings cannot queue behind or block quick card lookups', (t) => {
  const { client } = fixture(t);
  assert.notStrictEqual(client.slotFor('cardRankings'), client.slotFor('card'));
  assert.notStrictEqual(client.slotFor('auctions'), client.slotFor('card'));
  assert.notStrictEqual(client.slotFor('auctions'), client.slotFor('overview'));
  assert.notStrictEqual(client.slotFor('status'), client.slotFor('overview'));
});

test('equivalent range filters share in-flight and cached work despite unrelated query parameters', async (t) => {
  const { client } = fixture(t);
  let executions = 0;
  for (const slot of client.heavy) {
    const run = slot.run.bind(slot);
    slot.run = (...args) => { executions++; return run(...args); };
  }
  const first = client.call('overview', { range: 'all', rarity: 'R,C,R', tz: '240', page: '1' });
  const second = client.call('overview', { rarity: 'C,R', range: 'all', tz: '300' });
  assert.strictEqual(first, second);
  const value = await first;
  assert.strictEqual(await client.call('overview', { range: 'all', rarity: 'R,C' }), value);
  assert.equal(executions, 1);
});

test('foreground work overtakes background refreshes that have not started', async (t) => {
  const { client } = fixture(t);
  const slot = client.slotFor('users');
  let release;
  slot.stopping = new Promise((resolve) => { release = resolve; });
  const order = [];
  const spawn = slot.spawn.bind(slot);
  slot.spawn = () => {
    const worker = spawn();
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message) => { order.push(message.args[0]); post(message); };
    return worker;
  };
  const active = slot.run('users', ['active']);
  const background = slot.run('users', ['background'], true);
  const foreground = slot.run('users', ['foreground']);
  release();
  await Promise.all([active, background, foreground]);
  assert.deepEqual(order, ['active', 'foreground', 'background']);
});

test('an expired queued request leaves the active query and worker healthy', async (t) => {
  const { client } = fixture(t, { queueTimeoutMs: 50 });
  const slot = client.slotFor('users');
  let release;
  slot.stopping = new Promise((resolve) => { release = resolve; });
  const active = client.call('users', 'active');
  const queued = client.call('users', 'queued');
  // Production HTTP/worker handles keep the loop alive; this artificial pre-spawn gate has none.
  await Promise.all([assert.rejects(queued, /busy/), new Promise((resolve) => setTimeout(resolve, 75))]);
  assert.equal(slot.tasks.size, 1);
  release();
  assert.deepEqual(await active, []);
  const worker = slot.worker;
  assert.deepEqual(await client.call('users', 'next'), []);
  assert.strictEqual(slot.worker, worker);
  assert.equal(client.lastError, null);
});

test('disconnected HTTP subscribers discard obsolete queued work without cancelling a shared caller', async (t) => {
  const { client } = fixture(t);
  const slot = client.slotFor('users');
  let release;
  slot.stopping = new Promise((resolve) => { release = resolve; });
  const active = client.call('users', 'active');
  const first = new AbortController();
  const second = new AbortController();
  const one = client.callWithSignal('users', ['shared'], first.signal);
  const two = client.callWithSignal('users', ['shared'], second.signal);
  assert.equal(client.pending, 2, 'one queued job for both HTTP requests');
  first.abort();
  await assert.rejects(one, /cancelled/);
  assert.equal(client.pending, 2, 'remaining subscriber retains its work');
  second.abort();
  await assert.rejects(two, /cancelled/);
  assert.equal(client.pending, 1, 'last subscriber removes the queued job');
  assert.equal(client.inflight.has(JSON.stringify(['users', ['shared']])), false);
  const replacement = client.call('users', 'shared');
  release();
  assert.deepEqual(await active, []);
  assert.deepEqual(await replacement, []);
  assert.equal(client.lastError, null);
});

test('aborting one request preserves both another HTTP subscriber and a direct caller', async (t) => {
  const { client } = fixture(t);
  const slot = client.slotFor('users');
  let release;
  slot.stopping = new Promise((resolve) => { release = resolve; });
  const active = client.call('users', 'active');
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = client.callWithSignal('users', ['shared'], first.signal);
  const remaining = client.callWithSignal('users', ['shared'], second.signal);
  const direct = client.call('users', 'shared');
  first.abort();
  await assert.rejects(cancelled, /cancelled/);
  release();
  assert.deepEqual(await active, []);
  assert.deepEqual(await remaining, []);
  assert.deepEqual(await direct, []);
});

test('dashboard startup can answer health requests while cold diagnostic counts are pending', async (t) => {
  const { client } = fixture(t);
  let release;
  client.slotFor('status').stopping = new Promise((resolve) => { release = resolve; });
  assert.strictEqual(await client.start({ waitForStatus: false }), client);
  assert.equal(client.snapshot, null);
  assert.equal(client.status().pending, 1);
  release();
  await client.statusRefresh;
  assert.equal(client.status().db.auctions, 0);
});
