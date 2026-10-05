import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Session } from '../src/http.js';
import { AccountPool } from '../src/accounts.js';
import { Collector } from '../src/collector.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const session = (request) => ({ hasCookie: () => true, userId: () => 'test-account',
  username: () => 'test-account', request });

test('pool watchdog releases account and collector slots and ignores a late result', async () => {
  const late = deferred();
  let calls = 0, stored = 0, tried = 0, signal;
  const reply = { status: 200, json: { auction: { id: 'auction', status: 'settled_unsold' } } };
  const pool = new AccountPool([session((_method, _path, options) => {
    signal = options.signal;
    return ++calls === 1 ? late.promise : Promise.resolve(reply);
  })], { maxRps: 1000, requestTimeoutMs: 20 }, () => {});
  const store = { getMeta: () => null, markTried: () => tried++, saveResult: () => {
    stored++;
    return { stored: true };
  } };
  const collector = new Collector(store, pool, { recentInitialLookbackSec: 120 }, () => {});
  const pending = { due: Date.now() - 1, tries: 0 };
  collector.pending.set('auction', pending);
  await collector.settle('auction', pending);
  assert.equal(signal.aborted, true);
  assert.equal(pool.status()[0].inflight, 0);
  assert.equal(pool.status()[0].needsLogin, false);
  assert.equal(collector.inflight, 0);
  assert.equal(pending.busy, false);
  assert.equal(pending.tries, 1);
  assert.equal(tried, 1);
  assert.ok(collector.pending.has('auction'));
  assert.ok(pending.due > Date.now());
  await collector.settle('auction', pending);
  assert.equal(collector.pending.size, 0);
  assert.equal(stored, 1);
  late.resolve(reply);
  await turn();
  assert.equal(stored, 1);
  assert.equal(pool.status()[0].inflight, 0);
  assert.equal(collector.inflight, 0);
});

test('session deadline bounds a stalled refresh before fetch starts', async (t) => {
  const s = new Session(new Map());
  const late = deferred();
  s.ensureFresh = () => late.promise;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; throw new Error('unexpected network call'); });
  await assert.rejects(s.request('GET', '/test', { timeoutMs: 20 }), { name: 'TimeoutError' });
  late.resolve();
  await turn();
  assert.equal(calls, 0);
});

test('session deadline bounds fetch headers even when fetch ignores abort', async (t) => {
  const s = new Session(new Map());
  const late = deferred();
  let signal;
  t.mock.method(globalThis, 'fetch', (_url, options) => { signal = options.signal; return late.promise; });
  await assert.rejects(s.request('GET', '/test', { timeoutMs: 20 }), { name: 'TimeoutError' });
  assert.equal(signal.aborted, true);
  late.resolve({ text: async () => '{}', headers: new Headers(), status: 200 });
  await turn();
});

test('stalled response body expires and a late cookie cannot overwrite the session', async (t) => {
  const s = new Session(new Map([['existing', 'value']]));
  const late = deferred();
  let absorbed = 0, signal;
  s.absorb = () => absorbed++;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return { status: 200, text: () => late.promise, headers: new Headers() };
  });
  await assert.rejects(s.request('GET', '/test', { timeoutMs: 20 }), { name: 'TimeoutError' });
  assert.equal(signal.aborted, true);
  late.resolve('{}');
  await turn();
  assert.equal(absorbed, 0);
});

test('caller cancellation releases a session request promptly', async (t) => {
  const s = new Session(new Map());
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  const controller = new AbortController();
  const result = assert.rejects(s.request('GET', '/test', { signal: controller.signal }), { name: 'AbortError' });
  controller.abort();
  await result;
});

test('refresh watchdog clears the shared refresh and ignores a late rotated token', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(fs, 'readFileSync', () => 'SUPABASE_ANON_KEY=test-only');
  const s = new Session(new Map());
  s.readAuth = () => ({ refresh_token: 'test-only', expires_at: Date.now() / 1000 + 100 });
  s.renewWhenLeftSec = 300;
  s.onLog = () => {};
  const late = deferred();
  let writes = 0, calls = 0;
  s.writeAuth = () => writes++;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: () => calls === 1 ? late.promise : Promise.resolve({ access_token: 'test-only', expires_in: 3600 }) };
  });
  const first = s.ensureFresh();
  const second = s.ensureFresh();
  const rejected = Promise.all([assert.rejects(first, { name: 'TimeoutError' }),
    assert.rejects(second, { name: 'TimeoutError' })]);
  await turn();
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(s._refreshing, null);
  assert.equal(calls, 1);
  await s.ensureFresh();
  assert.equal(writes, 1);
  late.resolve({ access_token: 'stale-test-only', expires_in: 3600 });
  await turn();
  assert.equal(writes, 1);
});
