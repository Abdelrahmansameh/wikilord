import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync, readdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startDashboard } from '../src/server.js';
import { StateStore } from '../src/state.js';

test('dashboard serves state but requires a same-origin JSON request for actions', async () => {
  let cycles = 0;
  let packRetries = 0;
  let verificationRetries = 0;
  const engine = {
    getState: () => ({ mode: 'dry-run', decisions: [], slots: { active: 0, max: 5, free: 5 } }),
    runNow: async () => { cycles++; return { ok: true }; },
    retryPacks: () => { packRetries++; return { ok: true }; },
    retryVerification: () => { verificationRetries++; return { ok: true, queued: true, recoveredAuctions: 2 }; },
    pause: () => ({ ok: true }), resume: () => ({ ok: true }),
  };
  const session = { username: () => null, hasCookie: () => false };
  const server = startDashboard({ engine, session, config: { ui: { port: 0 } } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.mode, 'dry-run');
    assert.equal(state.slots.max, 5);
    assert.deepEqual((await (await fetch(`${base}/api/examples`)).json()).rows, []);

    const refused = await fetch(`${base}/api/run`, {
      method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(refused.status, 403);
    assert.equal(cycles, 0);

    const allowed = await fetch(`${base}/api/run`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(allowed.status, 200);
    assert.equal(cycles, 1);
    const retry = await fetch(`${base}/api/packs/retry`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(retry.status, 202);
    assert.equal(packRetries, 1);
    const verificationRetry = await fetch(`${base}/api/verification/retry`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(verificationRetry.status, 202);
    assert.equal((await verificationRetry.json()).recoveredAuctions, 2);
    assert.equal(verificationRetries, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('paused account status stays responsive while listing refresh waits on the site', async () => {
  let refreshes = 0;
  const engine = { getState: () => ({ paused: true, connected: true, mode: 'live' }),
    refreshListings: () => { refreshes++; return new Promise(() => {}); } };
  const session = { username: () => 'premium', hasCookie: () => true };
  const server = startDashboard({ config: { ui: { port: 0 } }, accounts: {
    premium: { engine, session, config: { ui: { port: 0 } } },
  } });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/premium/state`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).paused, true);
    assert.equal(refreshes, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('premium routes isolate state and history, and validated settings replan only premium deals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-money-premium-ui-'));
  const configFile = join(dir, 'premium.config.json');
  const standardEvents = join(dir, 'standard.jsonl');
  const premiumEvents = join(dir, 'premium.jsonl');
  const premiumConfig = JSON.parse(readFileSync(new URL('../premium.config.example.json', import.meta.url)));
  writeFileSync(configFile, JSON.stringify(premiumConfig));
  writeFileSync(standardEvents, JSON.stringify({ at: 1, type: 'listed', title: 'Standard only' }) + '\n');
  writeFileSync(premiumEvents, JSON.stringify({ at: 2, type: 'deal-won', title: 'Premium only' }) + '\n');
  let standardPaused = 0, premiumPaused = 0, premiumReplans = 0, premiumBusy = false, updated;
  const standardEngine = { getState: () => ({ account: 'standard', mode: 'dry-run' }),
    pause: () => { standardPaused++; } };
  const premiumEngine = { getState: () => ({ account: 'premium', mode: 'dry-run', busy: premiumBusy }),
    getDeals: () => ({ plans: [{ auctionId: 'auction-premium' }] }),
    pause: () => { premiumPaused++; },
    updateConfig: (c) => { updated = c; premiumReplans++; } };
  const session = { username: () => 'standard', hasCookie: () => false };
  const premiumSession = { username: () => 'premium', hasCookie: () => false };
  const server = startDashboard({ config: { ui: { port: 0 } }, accounts: {
    standard: { engine: standardEngine, session, config: { ui: { port: 0 } }, historyFile: standardEvents },
    premium: { engine: premiumEngine, session: premiumSession, config: premiumConfig,
      configFile, historyFile: premiumEvents },
  } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const write = (path, body) => fetch(`${base}${path}`, { method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(`${base}/api/state`)).json()).account, 'standard');
    assert.equal((await (await fetch(`${base}/api/premium/state`)).json()).account, 'premium');
    assert.equal((await (await fetch(`${base}/api/premium/deals`)).json()).plans[0].auctionId, 'auction-premium');
    assert.match(await (await fetch(`${base}/premium/deals`)).text(), /Planned snipes/);
    assert.equal((await (await fetch(`${base}/api/history`)).json()).rows[0].title, 'Standard only');
    assert.equal((await (await fetch(`${base}/api/premium/history`)).json()).rows[0].title, 'Premium only');
    assert.equal((await (await fetch(`${base}/api/premium/history?category=deals`)).json()).rows[0].type, 'deal-won');
    assert.equal((await write('/api/premium/settings', { buy: { minProfit: -1 } })).status, 400);
    assert.equal((await write('/api/premium/settings', { buy: { maxQuotesPerScan: 1001 } })).status, 400);
    assert.equal((await write('/api/premium/settings', { buy: { resaleAttempts: 0 } })).status, 400);
    assert.equal((await write('/api/premium/settings', { buy: { maxQueueSize: 50, maxPlans: 100 } })).status, 400);
    assert.equal(JSON.parse(readFileSync(configFile)).buy.minProfit, 200);
    const saved = await write('/api/premium/settings', { buy: { minProfit: 250, premiumMinProfit: 85, maxQueueSize: 3000 } });
    assert.equal(saved.status, 202);
    for (let i = 0; i < 200 && updated?.buy.minProfit !== 250; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(JSON.parse(readFileSync(configFile)).buy.minProfit, 250);
    assert.equal(updated.buy.minProfit, 250);
    assert.equal(updated.buy.premiumMinProfit, 85);
    assert.equal(updated.buy.maxQueueSize, 3000);
    assert.equal(updated.buy.hybridEnabled, true);
    assert.equal(premiumReplans, 1);
    assert.equal((await (await fetch(`${base}/api/premium/settings`)).json()).buy.minProfit, 250);
    premiumBusy = true;
    assert.equal((await write('/api/premium/settings', { buy: { minProfit: 260 } })).status, 202);
    assert.equal((await write('/api/premium/settings', { trades: { pollSeconds: 75 } })).status, 202);
    const pending = await (await fetch(`${base}/api/premium/settings`)).json();
    assert.equal(pending.pendingSettings.status, 'queued');
    assert.equal(pending.buy.minProfit, 260);
    assert.equal(pending.config.buy.minProfit, 250);
    assert.equal(JSON.parse(readFileSync(configFile)).buy.minProfit, 250);
    premiumBusy = false;
    for (let i = 0; i < 200 && updated?.buy.minProfit !== 260; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(updated.buy.minProfit, 260);
    assert.equal(updated.trades.pollSeconds, 75);
    assert.equal(premiumReplans, 2);
    await write('/api/premium/pause', {});
    assert.equal(premiumPaused, 1);
    assert.equal(standardPaused, 0);
    await write('/api/pause', {});
    assert.equal(standardPaused, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const file of [configFile, standardEvents, premiumEvents]) unlinkSync(file);
    rmdirSync(dir);
  }
});

test('premium connection rejects a login already active on the standard money account', async () => {
  const id = randomUUID();
  let replaced = false;
  class TestSession { static async test() { return { ok: true, id, account: 'duplicate', status: 200 }; } }
  const standardSession = { userId: () => id, hasCookie: () => true };
  const premiumSession = { constructor: TestSession, hasCookie: () => false,
    replaceCookie: () => { replaced = true; } };
  const engine = { getState: () => ({}) };
  const server = startDashboard({ config: { ui: { port: 0 } }, accounts: {
    standard: { engine, session: standardSession, config: { ui: { port: 0 } } },
    premium: { engine, session: premiumSession, config: { ui: { port: 0 } } },
  } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/premium/cookie`, { method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: 'sb-cyrxjeppjqsxxjayfrur-auth-token=example' }) });
    assert.equal(response.status, 409);
    assert.equal(replaced, false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('premium account switching is explicit, archives old state, and leaves the new account paused', async () => {
  const oldId = randomUUID(), newId = randomUUID();
  let archived = 0, reset = 0, replaced = 0;
  class TestSession { static async test() { return { ok: true, id: newId, account: 'new-premium', balance: 2500, status: 200 }; } }
  const premiumStore = { archiveAndReset: () => { archived++; } };
  const standardSession = { userId: () => randomUUID(), hasCookie: () => true };
  const premiumSession = { constructor: TestSession, userId: () => oldId, hasCookie: () => true,
    replaceCookie: () => { replaced++; } };
  const premiumEngine = { getState: () => ({ busy: false }), resetForAccountSwitch: async (id) => {
    assert.equal(id, newId); reset++; return premiumStore.archiveAndReset() ?? { key: 'old-premium-archive' };
  } };
  const server = startDashboard({ config: { ui: { port: 0 } }, accounts: {
    standard: { engine: { getState: () => ({}) }, session: standardSession, config: { ui: { port: 0 } } },
    premium: { engine: premiumEngine, session: premiumSession, config: { ui: { port: 0 } }, store: premiumStore },
  } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const write = (path) => fetch(`${base}${path}`, { method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ cookie: 'sb-cyrxjeppjqsxxjayfrur-auth-token=example' }) });
  try {
    assert.equal((await write('/api/premium/cookie')).status, 409);
    assert.equal(archived, 0);
    const response = await write('/api/premium/switch-account');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, account: 'new-premium', balance: 2500,
      paused: true, archived: { key: 'old-premium-archive' } });
    assert.equal(archived, 1);
    assert.equal(reset, 1);
    assert.equal(replaced, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('premium state archives its old journal before starting with an empty account checkpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-premium-switch-'));
  const stateFile = join(dir, 'state.json'), eventFile = join(dir, 'events.jsonl');
  const archiveDirectory = join(dir, 'archives');
  writeFileSync(stateFile, JSON.stringify({ accountId: 'old-login', balance: 777, bids: { held: { amount: 50 } } }));
  writeFileSync(eventFile, JSON.stringify({ at: 1, type: 'deal-won', title: 'Old account event' }) + '\n');
  const store = new StateStore({ file: stateFile, eventFile, account: 'premium', archiveDirectory });
  try {
    const archive = store.archiveAndReset({ label: 'old-login' });
    const archivedState = JSON.parse(readFileSync(join(archiveDirectory, `${archive.key}.state.json`), 'utf8'));
    assert.equal(archivedState.balance, 777);
    assert.equal(archivedState.accountId, 'old-login');
    assert.match(readFileSync(join(archiveDirectory, `${archive.key}.events.jsonl`), 'utf8'), /Old account event/);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).balance, undefined);
    assert.deepEqual(store.data.bids, {});
    assert.deepEqual(store.data.purchases, {});
    assert.deepEqual(store.data.tradeOffers.pending, []);
    assert.equal(readFileSync(eventFile, 'utf8'), '');
    assert.deepEqual(store.events, []);
  } finally {
    const files = [stateFile, eventFile, `${stateFile}.tmp`];
    for (const file of files) { try { unlinkSync(file); } catch {} }
    for (const file of readdirSync(archiveDirectory)) unlinkSync(join(archiveDirectory, file));
    rmdirSync(archiveDirectory); rmdirSync(dir);
  }
});

test('active listing details quote the actual listed card and reject inactive IDs', async () => {
  const listing = { auctionId: 'auction-1', cardId: 'card-1', title: 'Example', rarity: 'SR',
    shiny: true, price: 14, qScore: 72, pageviews: 50, atk: 4, def: 5, category: 'example' };
  let quoted;
  const engine = { getState: () => ({ activeListings: [listing] }) };
  const session = { username: () => null, hasCookie: () => false };
  const model = { quote: async (card, options) => {
    quoted = { card, options };
    return { curve: [{ price: 14, p: 0.7, L: 2 }], evidence: { rawSold: 3 } };
  } };
  const server = startDashboard({ engine, session, model, config: { ui: { port: 0 } } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/listings/auction-1/details`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.listing.price, 14);
    assert.equal(detail.quote.evidence.rawSold, 3);
    assert.equal(quoted.card.shiny, true);
    assert.equal(quoted.card.cardId, 'card-1');
    assert.equal(quoted.options.targetProbability, 0.8);
    assert.equal((await fetch(`${base}/api/listings/other/details`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('premium active listing details use an above-median probability curve', async () => {
  const listing = { auctionId: 'premium-1', cardId: 'card-1', title: 'Premium', rarity: 'UR',
    shiny: false, price: 620, kind: 'premium' };
  const config = JSON.parse(readFileSync(new URL('../premium.config.example.json', import.meta.url)));
  let premiumPrices;
  const model = { stats: async () => ({ soldCount: 5, median: 550, p25: 490 }),
    quoteAtPrices: async (_facts, prices) => { premiumPrices = prices; return {
      curve: prices.map((price) => ({ price, p: price <= 620 ? 0.4 : 0.2 })),
      evidence: { source: 'exact-card-premium' } }; } };
  const engine = { getState: () => ({ activeListings: [listing] }) };
  const session = { username: () => null, hasCookie: () => false };
  const server = startDashboard({ config: { ui: { port: 0 } }, model, accounts: {
    standard: { engine, session, config: { ui: { port: 0 } } },
    premium: { engine, session, config },
  } });
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/premium/listings/premium-1/details`);
    assert.equal(r.status, 200);
    const detail = await r.json();
    assert.equal(detail.strategy, 'premium');
    assert.equal(detail.stats.median, 550);
    assert.ok(premiumPrices.includes(620));
    assert.ok(premiumPrices.some((price) => price > 550));
    assert.equal(detail.quote.evidence.source, 'exact-card-premium');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('hybrid watched deal details use the resale quote with own failed listings and invalidate its cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-hybrid-deal-detail-'));
  const file = join(dir, 'market.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE auctions (
    id TEXT, card_id TEXT, title TEXT, rarity TEXT, is_shiny INTEGER, seller_id TEXT,
    base_amount INTEGER, listing_base_amount INTEGER, current_bid INTEGER,
    current_bidder_id TEXT, effective_bid INTEGER, bid_count INTEGER, status TEXT,
    final INTEGER, final_price INTEGER, end_at INTEGER, q_score REAL, pageviews INTEGER,
    atk INTEGER, def INTEGER, category TEXT
  )`);
  db.prepare(`INSERT INTO auctions (id, card_id, title, rarity, is_shiny, base_amount,
    listing_base_amount, status, final, end_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('hybrid-1', 'card-1', 'Proven affordable', 'SR', 0, 50, 50, 'active', 0, Date.now() + 60000);
  db.close();
  const config = JSON.parse(readFileSync(new URL('../premium.config.example.json', import.meta.url)));
  config.marketDb = pathToFileURL(file).href;
  const failed = { auctionId: 'failed-1', cardId: 'card-1', rarity: 'SR', shiny: false,
    status: 'settled_unsold', price: 110 };
  const store = { data: { listings: { 'failed-1': failed }, stats: { sold: 0, unsold: 1 } } };
  const engine = { getState: () => ({}), getPortfolio: () => ({ cutoff: { value: 2 }, queueDepth: 3, slots: { max: 5 } }),
    getDeals: () => ({ watchlist: [{ auctionId: 'hybrid-1', cardId: 'card-1', title: 'Proven affordable',
      rarity: 'SR', shiny: false, lane: 'liquid', status: 'watching', safeExit: 100, maxBid: 65 }] }) };
  const session = { username: () => null, hasCookie: () => false };
  let calls = 0, received;
  const model = {
    stats: async () => ({ soldCount: 12, median: 120, p25: 100 }),
    dealQuote: async (card, options) => { calls++; received = { card, options }; return {
      curve: [{ price: 100, p: 0.6, pLow: 0.5, pHigh: 0.7 }],
      evidence: { source: 'exact-variant-relisting', rawSold: 12, rawUnsold: options.ownOutcomes.length } }; },
    quoteAtPrices: async () => { throw new Error('legacy quote should not be used'); },
  };
  const server = startDashboard({ config: { ui: { port: 0 } }, model, accounts: {
    premium: { config, engine, session, store },
  } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await (await fetch(`${base}/api/premium/deals/hybrid-1/details`)).json();
    assert.equal(first.deal.status, 'watching');
    assert.equal(first.quote.evidence.source, 'exact-variant-relisting');
    assert.equal(first.modelError, null);
    assert.equal(received.card.cardId, 'card-1');
    assert.equal(received.options.buy.hybridEnabled, true);
    assert.equal(received.options.durationMinutes, 60);
    assert.equal(received.options.cutoff, 2);
    assert.deepEqual(received.options.ownOutcomes, [failed]);
    await fetch(`${base}/api/premium/deals/hybrid-1/details`);
    assert.equal(calls, 1);
    store.data.listings['failed-2'] = { ...failed, auctionId: 'failed-2' };
    store.data.stats.unsold = 2;
    const refreshed = await (await fetch(`${base}/api/premium/deals/hybrid-1/details`)).json();
    assert.equal(calls, 2);
    assert.equal(refreshed.quote.evidence.rawUnsold, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    unlinkSync(file); rmdirSync(dir);
  }
});

test('auction history returns every recorded outcome for one card ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-money-auctions-'));
  const file = join(dir, 'market.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE auctions (
    id TEXT, card_id TEXT, rarity TEXT, is_shiny INTEGER, status TEXT, final INTEGER,
    listing_base_amount INTEGER, base_amount INTEGER, final_price INTEGER,
    current_bid INTEGER, bid_count INTEGER, base_repriced_at INTEGER,
    end_at INTEGER, settled_at INTEGER, created_at INTEGER
  )`);
  const insert = db.prepare(`INSERT INTO auctions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('sold', 'card-1', 'R', 0, 'settled_sold', 1, 20, 20, 30, null, 2, null, 300, 300, 100);
  insert.run('unsold', 'card-1', 'R', 0, 'settled_unsold', 1, 40, 40, null, null, 0, null, 200, 200, 100);
  insert.run('cancelled', 'card-1', 'UR', 1, 'cancelled', 1, 50, 50, null, null, 0, null, 100, 100, 100);
  insert.run('other', 'card-2', 'R', 0, 'settled_sold', 1, 10, 10, 12, null, 1, null, 400, 400, 100);
  db.close();
  const previous = process.env.WM_MARKET_DB;
  process.env.WM_MARKET_DB = file;
  const engine = { getState: () => ({ connected: false }) };
  const session = { username: () => null, hasCookie: () => false };
  const server = startDashboard({ engine, session, config: { ui: { port: 0 } } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/auctions?cardId=card-1`);
    assert.equal(response.status, 200);
    const history = await response.json();
    assert.deepEqual(history.rows.map((row) => row.id), ['sold', 'unsold', 'cancelled']);
    assert.equal(history.rows[0].finalPrice, 30);
    assert.equal(history.rows[2].rarity, 'UR');
    assert.equal((await fetch(`${base}/api/auctions?cardId=%20`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous == null) delete process.env.WM_MARKET_DB;
    else process.env.WM_MARKET_DB = previous;
    unlinkSync(file);
    rmdirSync(dir);
  }
});

test('history page reads the durable journal with stable pagination and filters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-money-history-'));
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, Array.from({ length: 120 }, (_, i) => JSON.stringify({ at: 1000 + i,
    type: 'listed', title: `Card ${i}`, price: i })).join('\n') + '\n');
  const engine = { getState: () => ({ connected: false }) };
  const session = { username: () => null, hasCookie: () => false };
  const server = startDashboard({ engine, session, config: { ui: { port: 0 } }, historyFile: file });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/history`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="history-view"/);
    const first = await (await fetch(`${base}/api/history?category=listings`)).json();
    assert.equal(first.total, 120);
    assert.equal(first.rows.length, 50);
    assert.equal(first.rows[0].title, 'Card 119');
    appendFileSync(file, JSON.stringify({ at: 2000, type: 'sold', title: 'New sale', price: 40 }) + '\n');
    const older = await (await fetch(`${base}/api/history?category=listings&before=${first.nextBefore}`)).json();
    assert.equal(older.rows[0].title, 'Card 69');
    assert.equal(older.rows.length, 50);
    const searched = await (await fetch(`${base}/api/history?q=Card%207`)).json();
    assert.ok(searched.rows.every((event) => event.title.includes('Card 7')));
    assert.equal((await fetch(`${base}/api/history?before=bad`)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    unlinkSync(file);
    rmdirSync(dir);
  }
});
