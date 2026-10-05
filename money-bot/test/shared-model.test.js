import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedMarketModel } from '../src/shared-model.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('both accounts share a lazy opening and do not immediately rebuild a freshly opened model', async () => {
  const opening = deferred();
  let opens = 0, refreshes = 0, time = 100;
  const worker = { ready: async () => 123, health: async () => ({ ready: true, dataTimestamp: 123 }),
    refresh: async () => { refreshes++; return { dataTimestamp: 124 }; }, close: async () => {} };
  const shared = createSharedMarketModel({ open: () => { opens++; return opening.promise; }, now: () => time });
  assert.equal(opens, 0);
  const standard = shared.refresh(), premium = shared.refresh(), health = shared.health();
  assert.equal(standard, premium);
  assert.equal(opens, 1);
  time = 180_000; // A slow first build must still count as fresh when it completes.
  opening.resolve(worker);
  assert.deepEqual(await standard, { dataTimestamp: 123 });
  assert.equal((await health).ready, true);
  assert.equal(refreshes, 0);
  time += 59_999;
  await shared.refresh();
  assert.equal(refreshes, 0);
  time++;
  await shared.refresh();
  assert.equal(refreshes, 1);
  await shared.close();
});

test('concurrent refreshes share one rebuild, and its completed result remains fresh', async () => {
  let time = 0, rebuilds = 0;
  const rebuilding = deferred();
  const shared = createSharedMarketModel({ now: () => time, open: async () => ({
    ready: async () => 1, stats: async facts => ({ cardId: facts.cardId }),
    refresh: () => { rebuilds++; return rebuilding.promise; }, close: async () => {},
  }) });
  await shared.stats({ cardId: 'proven' });
  time = 60_000;
  const first = shared.refresh(), second = shared.refresh();
  await Promise.resolve();
  assert.equal(first, second);
  assert.equal(rebuilds, 1);
  time = 240_000;
  rebuilding.resolve({ dataTimestamp: 2 });
  assert.deepEqual(await first, { dataTimestamp: 2 });
  time += 59_999;
  assert.deepEqual(await shared.refresh(), { dataTimestamp: 2 });
  assert.equal(rebuilds, 1);
  await shared.close();
});

test('failed opening and failed refresh are retryable without poisoning the shared model', async () => {
  let opens = 0, refreshes = 0, time = 0;
  const shared = createSharedMarketModel({ now: () => time, open: async () => {
    if (++opens === 1) throw new Error('database temporarily unavailable');
    return { ready: async () => 1, health: async () => ({ ready: true }),
      refresh: async () => { if (++refreshes === 1) throw new Error('refresh failed'); return { dataTimestamp: 2 }; },
      close: async () => {} };
  } });
  await assert.rejects(shared.refresh(), /temporarily unavailable/);
  assert.equal((await shared.health()).ready, true);
  assert.equal(opens, 2);
  time = 60_000;
  await assert.rejects(shared.refresh(), /refresh failed/);
  assert.deepEqual(await shared.refresh(), { dataTimestamp: 2 });
  assert.equal(refreshes, 2);
  await shared.close();
});

test('closing an unopened or opening facade cannot create a lingering worker', async () => {
  let opens = 0, closes = 0;
  const unopened = createSharedMarketModel({ open: async () => { opens++; } });
  await unopened.close();
  assert.equal(opens, 0);
  await assert.rejects(unopened.health(), /closed/);
  const opening = deferred();
  const shared = createSharedMarketModel({ open: () => opening.promise });
  const read = shared.health();
  const close = shared.close();
  opening.resolve({ close: async () => { closes++; } });
  await assert.rejects(read, /closed/);
  await close;
  assert.equal(closes, 1);
});

test('replacement refresh serves bids throughout the build and drains old requests before closing', async () => {
  let time = 0, opens = 0, oldClosed = 0;
  const building = deferred(), longQuote = deferred();
  const old = { ready: async () => 100, dealQuote: async (facts) => facts.long ? longQuote.promise : { cap: 50 },
    close: async () => { oldClosed++; } };
  const replacement = { ready: () => building.promise, dealQuote: async () => ({ cap: 70 }), close: async () => {} };
  const shared = createSharedMarketModel({ replaceOnRefresh: true, now: () => time,
    open: () => ++opens === 1 ? old : replacement });
  assert.deepEqual(await shared.dealQuote({}), { cap: 50 });
  time = 60000;
  const slow = shared.dealQuote({ long: true });
  const refreshing = shared.refresh();
  assert.deepEqual(await shared.dealQuote({}), { cap: 50 }, 'bid pricing does not wait for the build');
  assert.equal(shared.refresh(), refreshing, 'both accounts share the replacement');
  building.resolve(200);
  assert.deepEqual(await refreshing, { dataTimestamp: 200 });
  assert.deepEqual(await shared.dealQuote({}), { cap: 70 });
  assert.equal(oldClosed, 0, 'an old quote is still in flight');
  longQuote.resolve({ cap: 45 });
  assert.deepEqual(await slow, { cap: 45 });
  await Promise.resolve();
  assert.equal(oldClosed, 1);
  await shared.close();
});

test('a failed replacement leaves the current pricing model available and can be retried', async () => {
  let time = 0, opens = 0, closes = 0;
  const shared = createSharedMarketModel({ replaceOnRefresh: true, now: () => time, open: () => {
    const id = ++opens;
    return { ready: async () => { if (id === 2) throw new Error('build failed'); return id; },
      stats: async () => id, close: async () => { closes++; } };
  } });
  assert.equal(await shared.stats({}), 1);
  time = 60000;
  await assert.rejects(shared.refresh(), /build failed/);
  assert.equal(await shared.stats({}), 1);
  assert.equal(closes, 1);
  await shared.refresh();
  assert.equal(await shared.stats({}), 3);
  await shared.close();
});

test('shutdown aborts a replacement build and never publishes it after closing', async () => {
  let time = 0, opens = 0, closes = 0;
  const building = deferred();
  const shared = createSharedMarketModel({ replaceOnRefresh: true, now: () => time, open: () => {
    const id = ++opens;
    return { ready: () => id === 1 ? Promise.resolve(1) : building.promise,
      stats: async () => id, close: async () => { closes++; if (id === 2) building.reject(new Error('closed build')); } };
  } });
  await shared.stats({}); time = 60000;
  const refreshing = shared.refresh();
  // Attach rejection handling before shutdown cancels the building worker.
  const failed = assert.rejects(refreshing, /closed/);
  await Promise.resolve(); await Promise.resolve();
  await shared.close(); await failed;
  assert.equal(closes, 2);
  await assert.rejects(shared.stats({}), /closed/);
});
