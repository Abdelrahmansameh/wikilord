import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDealEngine, dealBidCap, dealReserve, nextDealBid } from '../src/deals.js';

const ID = {
  a: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  b: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  c: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  d: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  e: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
};

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'money-deals-'));
  const dbPath = path.join(directory, 'market.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE auctions (
    id TEXT PRIMARY KEY, card_id TEXT, rarity TEXT, is_shiny INTEGER, title TEXT,
    seller_id TEXT, base_amount INTEGER, current_bid INTEGER, effective_bid INTEGER,
    current_bidder_id TEXT, end_at INTEGER, first_seen INTEGER, q_score REAL,
    pageviews INTEGER, atk INTEGER, def INTEGER, category TEXT, final INTEGER,
    status TEXT, final_price INTEGER
  ); CREATE TABLE cards(id TEXT PRIMARY KEY, times_sold INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX auctions_pending ON auctions(end_at) WHERE final=0;
  CREATE INDEX auctions_card ON auctions(card_id);
  CREATE INDEX auctions_sold_card_price ON auctions(card_id, final_price)
    WHERE final=1 AND status='settled_sold' AND final_price IS NOT NULL;`);
  let sequence = 0;
  const insert = db.prepare(`INSERT INTO auctions(id,card_id,rarity,is_shiny,title,seller_id,
    base_amount,current_bid,effective_bid,current_bidder_id,end_at,first_seen,q_score,
    pageviews,atk,def,category,final,status,final_price)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  function sold(cardId, price, rarity = 'UR', shiny = false) {
    const at = Date.now() - 120_000;
    db.prepare(`INSERT INTO cards(id,times_sold) VALUES(?,1)
      ON CONFLICT(id) DO UPDATE SET times_sold=times_sold+1`).run(cardId);
    insert.run(`sold-${++sequence}`, cardId, rarity, shiny ? 1 : 0, cardId, 'other',
      price, price, price, 'buyer', at, at, 0, 0, 0, 0, '', 1, 'settled_sold', price);
  }
  function listing(cardId, price, { old = false, endAt = Date.now() + 3_600_000,
    rarity = 'UR', shiny = false, id = `listing-${++sequence}` } = {}) {
    insert.run(id, cardId, rarity, shiny ? 1 : 0, cardId, 'other', price,
      null, price, null, endAt, Date.now() - (old ? 3_600_000 : 1_000),
      0, 0, 0, 0, '', 0, 'active', null);
    return id;
  }
  return { dbPath, db, sold, listing, close() {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}

function setup(t, dbPath, overrides = {}) {
  const config = { dryRun: true, listingFee: 0,
    premium: { minSold: 4, minMedian: 500 },
    buy: { enabled: true, minSold: 4, topCount: 5000, minProfit: 200,
      exitProbability: 0.8, reserveCoins: 1000, reserveFraction: 0.5,
      scanSeconds: 45, freshLookbackMinutes: 60, topRefreshMinutes: 30,
      maxRowsPerScan: 5000, maxQuotesPerScan: 60, targetRemainingMs: 15_000,
      preCheckLeadMs: 5_000, extraBidLatencyMs: 150,
      maxCounters: 2, bidIncrement: 1, minGapBetweenBidsMs: 0 }, ...overrides.config };
  config.buy = { enabled: true, minSold: 4, topCount: 5000, minProfit: 200,
    exitProbability: 0.8, reserveCoins: 1000, reserveFraction: 0.5, scanSeconds: 45,
    freshLookbackMinutes: 60, topRefreshMinutes: 30, maxRowsPerScan: 5000,
    maxQuotesPerScan: 60, targetRemainingMs: 15_000, preCheckLeadMs: 5000,
    extraBidLatencyMs: 150, maxCounters: 2, bidIncrement: 1, minGapBetweenBidsMs: 0,
    ...config.buy };
  const store = overrides.store ?? { data: {}, events: [], save() {}, record(type, fields) { this.events.push({ type, ...fields }); } };
  const model = { ...{
    async stats({ cardId }) {
      const data = overrides.statistics?.[cardId] ?? { soldCount: 4, median: 800, p25: 750 };
      return data;
    },
    async quoteAtPrices({ cardId }, prices) {
      const threshold = overrides.thresholds?.[cardId] ?? 700;
      return { curve: prices.map((price) => ({ price, p: price <= threshold ? 0.9 : 0.5 })),
        evidence: { rawSold: 4 } };
    },
  }, ...overrides.model };
  const portfolio = overrides.portfolio ?? { balance: 10_000, cutoff: 0, queueDepth: 0,
    slots: { max: 5 }, inventory: [], dry: true, paused: false };
  const session = overrides.session ?? { hasCookie: () => true, userId: () => 'mine',
    async request() { throw new Error('unexpected API call'); } };
  const engine = createDealEngine({ session, model, config, store, dbPath,
    getPortfolio: () => portfolio, accountAllowed: (id) => id !== 'other-bot',
    discovery: overrides.discovery, now: overrides.now ?? Date.now,
    liveRequested: overrides.liveRequested ?? false });
  return { engine, store, config, portfolio, model };
}

const hybridBuy = { hybridEnabled: true, liquidMinSold: 8, premiumMinProfit: 75, liquidMinProfit: 15,
  maxQueueSize: 2000, maxPlans: 100, planningHorizonMinutes: 15,
  maxLiveRefreshPerScan: 0, quoteCacheSeconds: 60 };
const hybridQuote = (lane = 'premium', maxBid = 500) => ({ maxBid, safeExit: lane === 'premium' ? 660 : 160,
  exitP: 0.55, horizonP: 0.86, attempts: 2.2, expectedFees: 8, slotCost: 4,
  minProfit: lane === 'premium' ? 75 : 15, minRoi: lane === 'premium' ? 0.15 : 0.25,
  lane, median: lane === 'premium' ? 800 : 200, p25: lane === 'premium' ? 660 : 160,
  soldCount: 12, buyers: 5, sellers: 4, dataTimestamp: Date.now(),
  resalePlan: { ask: lane === 'premium' ? 660 : 160, floor: lane === 'premium' ? 660 : 160,
    attemptLimit: 6, durationMinutes: 10, stepDownPct: 0.05, pricingVersion: 'hybrid-v1' } });
const observed = (auctionId, cardId, endAt = Date.now() + 300_000, lane = 'premium') => ({
  auctionId, cardId, rarity: 'UR', shiny: false, title: cardId, sellerId: 'other',
  baseAmount: 25, currentBid: null, endAt, lane, sources: ['recent'] });
const scanResult = (candidates = [], extra = {}) => ({ candidates, cursor: 1, builtAt: 1,
  variants: 10, premiumVariants: 5, liquidVariants: 5, considered: candidates.length, ...extra });

test('bid cap accounts for repeat listing fees, slot cost, and backlog', () => {
  const value = dealBidCap({ safeExit: 800, probability: 0.8, listingFee: 8,
    cutoff: 20, queueDepth: 5, slots: 5, minProfit: 200 });
  assert.equal(value.attempts, 1.25);
  assert.equal(value.expectedFees, 10);
  assert.equal(value.slotCost, 50);
  assert.equal(value.maxBid, 540);
  assert.equal(dealReserve(2000, 500, 1000, { reserveCoins: 1000, reserveFraction: 0.5 }), 1750);
  assert.equal(nextDealBid({ current_bid: 20, base_amount: 10 }), 22);
});

test('premium pool uses exact variants, all-history completed sales, and recent feed admits lower medians', async (t) => {
  const f = fixture(t);
  for (const price of [750, 800, 850, 900, 950]) f.sold(ID.a, price);
  for (const price of [350, 400, 450, 500]) f.sold(ID.b, price);
  for (const price of [800, 900, 1000]) f.sold(ID.c, price);
  for (const price of [450, 475, 525, 550]) f.sold(ID.d, price); // median exactly 500
  for (const price of [501, 501, 501, 501]) f.sold(ID.e, price);
  const a = f.listing(ID.a, 100, { old: true });
  const b = f.listing(ID.b, 100);
  f.listing(ID.c, 100, { old: true });
  f.listing(ID.c, 100);
  f.listing(ID.d, 100, { old: true });
  f.listing(ID.e, 100, { old: true });
  f.listing(ID.e, 400);
  const { engine, store } = setup(t, f.dbPath, { config: { buy: {
    enabled: true, minSold: 4, topCount: 1, minProfit: 200,
    exitProbability: 0.8, reserveCoins: 1000, reserveFraction: 0.5,
    scanSeconds: 45, freshLookbackMinutes: 60, topRefreshMinutes: 30,
    maxRowsPerScan: 5000, maxQuotesPerScan: 60, targetRemainingMs: 15_000,
    preCheckLeadMs: 5_000, extraBidLatencyMs: 150,
    maxCounters: 2, bidIncrement: 1, minGapBetweenBidsMs: 0 } },
    statistics: { [ID.b]: { soldCount: 4, median: 425, p25: 350 } },
    thresholds: { [ID.b]: 340 } });
  t.after(async () => { await engine.stop(); f.close(); });
  const state = await engine.scan();
  assert.equal(state.discovery.premiumVariants, 1);
  assert.deepEqual(new Set(state.candidates.map((candidate) => candidate.auctionId)), new Set([a, b]));
  assert.ok(state.rejections.some((item) => /minimum exact-variant sales/.test(item.reason)));
  assert.ok(state.rejections.some((item) => /lower-quartile resale/.test(item.reason)));
  assert.deepEqual(state.candidates.find((candidate) => candidate.auctionId === a).sources, ['premium-pool']);
  assert.deepEqual(state.candidates.find((candidate) => candidate.auctionId === b).sources, ['recent']);
  assert.ok(store.data.dealsCursor > 0);
});

test('stale market data blocks buy quotes even when the auction looks cheap', async (t) => {
  const f = fixture(t);
  for (const price of [700, 750, 800, 850]) f.sold(ID.a, price);
  f.listing(ID.a, 100);
  const { engine } = setup(t, f.dbPath, { config: { maxMarketAgeHours: 1 },
    statistics: { [ID.a]: { soldCount: 4, median: 775, p25: 700,
      dataTimestamp: Date.now() - 2 * 3_600_000 } } });
  t.after(async () => { await engine.stop(); f.close(); });
  const state = await engine.scan();
  assert.equal(state.candidates.length, 0);
  assert.ok(state.rejections.some((item) => /stale/.test(item.reason)));
});

test('restart reconciliation matches a won bid to its inventory copy', async (t) => {
  const f = fixture(t);
  const auctionId = f.listing(ID.a, 100);
  const portfolio = { balance: 9800, cutoff: 0, queueDepth: 0, slots: { max: 5 },
    inventory: [{ userCardId: 'new-copy', cardId: ID.a, title: 'Amour sucré', rarity: 'UR', shiny: false }],
    dry: true, paused: false };
  const session = { hasCookie: () => true, userId: () => 'mine', async request(method, endpoint) {
    assert.equal(method, 'GET');
    assert.equal(endpoint, `/api/marketplace/${auctionId}`);
    return { status: 200, json: { auction: { id: auctionId, card_id: ID.a,
      snapshot_rarity: 'UR', is_shiny: false, seller_id: 'other', base_amount: 100,
      current_bid: 120, end_at: new Date(Date.now() - 1000).toISOString(),
      status: 'settled_sold', winner_id: 'mine', final_price: 120,
      card: { rarity: 'UR' } }, bids: [{ bidder_id: 'mine', amount: 120 }] } };
  } };
  const { engine, store } = setup(t, f.dbPath, { portfolio, session });
  store.data.bids[auctionId] = { auctionId, cardId: ID.a, rarity: 'UR', shiny: false,
    amount: 120, status: 'leading', ownedBeforeIds: [], placedAt: Date.now() - 60_000 };
  t.after(async () => { await engine.stop(); f.close(); });
  await engine.reconcile();
  assert.equal(store.data.bids[auctionId].status, 'won');
  assert.equal(store.data.bids[auctionId].userCardId, 'new-copy');
  assert.equal(store.data.purchases['new-copy'].purchasePrice, 120);
  assert.equal(store.data.purchases['new-copy'].title, 'Amour sucré');
});

test('purchase names are resolved for legacy records, including bids outside the recent list', async (t) => {
  const f = fixture(t);
  const portfolio = { balance: 9800, inventory: [
    { userCardId: 'inventory-copy', cardId: ID.b, title: 'Georges Brassens' },
  ], dry: true, paused: false };
  const { engine, store } = setup(t, f.dbPath, { portfolio });
  t.after(async () => { await engine.stop(); f.close(); });
  store.data.bids['old-auction'] = { auctionId: 'old-auction', title: 'Amour sucré', status: 'won' };
  for (let i = 0; i < 100; i++) store.data.bids[`recent-${i}`] = { status: 'lost' };
  store.data.purchases = {
    'bought-copy': { userCardId: 'bought-copy', cardId: ID.a, auctionId: 'old-auction', purchasePrice: 62 },
    'inventory-copy': { userCardId: 'inventory-copy', cardId: ID.b, purchasePrice: 70 },
    'named-copy': { userCardId: 'named-copy', cardId: ID.c, title: 'Saved name', auctionId: 'old-auction' },
  };
  const state = engine.getState();
  assert.ok(!state.bids.some((bid) => bid.auctionId === 'old-auction'));
  assert.equal(state.purchases.find((purchase) => purchase.userCardId === 'bought-copy').title, 'Amour sucré');
  assert.equal(state.purchases.find((purchase) => purchase.userCardId === 'inventory-copy').title, 'Georges Brassens');
  assert.equal(state.purchases.find((purchase) => purchase.userCardId === 'named-copy').title, 'Saved name');
  assert.equal(store.data.purchases['bought-copy'].title, undefined);
});

test('a restarted leading bid schedules a capped counter after an outbid', async (t) => {
  const f = fixture(t);
  const auctionId = f.listing(ID.a, 100, { endAt: Date.now() + 60_000 });
  const session = { hasCookie: () => true, userId: () => 'mine', async request(method, endpoint) {
    assert.equal(method, 'GET');
    assert.equal(endpoint, `/api/marketplace/${auctionId}`);
    return { status: 200, json: { auction: { id: auctionId, card_id: ID.a,
      snapshot_rarity: 'UR', is_shiny: false, seller_id: 'other', base_amount: 100,
      current_bid: 150, current_bidder_id: 'rival',
      end_at: new Date(Date.now() + 60_000).toISOString(), status: 'active',
      card: { rarity: 'UR' } }, bids: [{ bidder_id: 'mine', amount: 100 },
      { bidder_id: 'rival', amount: 150 }] } };
  } };
  const { engine, store } = setup(t, f.dbPath, { session });
  store.data.bids[auctionId] = { auctionId, cardId: ID.a, rarity: 'UR', shiny: false,
    amount: 100, status: 'leading', maxBid: 500, counterCount: 0,
    ownedBeforeIds: [], placedAt: Date.now() - 60_000 };
  t.after(async () => { await engine.stop(); f.close(); });
  await engine.reconcile();
  assert.equal(store.data.bids[auctionId].status, 'outbid');
  assert.equal(engine.getState().plans[0]?.counter, true);
  assert.equal(store.events.filter((event) => event.type === 'deal-refund-observed').length, 1);
});

test('simultaneous plans reserve cash and a stale live bid is rejected before POST', async (t) => {
  const f = fixture(t);
  for (const price of [750, 800, 850, 900]) f.sold(ID.a, price);
  for (const price of [750, 800, 850, 900]) f.sold(ID.b, price);
  const endAt = Date.now() + 1200;
  const a = f.listing(ID.a, 100, { endAt, old: true });
  const b = f.listing(ID.b, 100, { endAt, old: true });
  const posts = [];
  const session = { hasCookie: () => true, userId: () => 'mine', async request(method, endpoint, options) {
    if (endpoint === '/api/wikibidous') return { status: 200, json: { balance: 1100 } };
    if (method === 'GET' && endpoint.startsWith('/api/marketplace/')) {
      const id = endpoint.split('/').at(-1);
      return { status: 200, json: { auction: { id, card_id: id === a ? ID.a : ID.b,
        snapshot_rarity: 'UR', is_shiny: false, seller_id: 'other',
        base_amount: 100, current_bid: 700, effective_bid: 700,
        current_bidder_id: 'rival', end_at: new Date(endAt).toISOString(),
        status: 'active', card: { wikipedia_title: 'Card', rarity: 'UR' } } } };
    }
    if (method === 'POST') { posts.push({ endpoint, options }); return { status: 200, json: { current_bid: 100 } }; }
    throw new Error(`unexpected ${method} ${endpoint}`);
  } };
  const portfolio = { balance: 1100, cutoff: 0, queueDepth: 0, slots: { max: 5 },
    inventory: [], dry: false, paused: false };
  const { engine } = setup(t, f.dbPath, { portfolio, session, liveRequested: true,
    config: { dryRun: false, buy: { enabled: true, minSold: 4, topCount: 5000, minProfit: 200,
      exitProbability: 0.8, reserveCoins: 1000, reserveFraction: 0.5,
      scanSeconds: 45, freshLookbackMinutes: 60, topRefreshMinutes: 30,
      maxRowsPerScan: 5000, maxQuotesPerScan: 60, targetRemainingMs: 350,
      preCheckLeadMs: 250, extraBidLatencyMs: 0,
      maxCounters: 2, bidIncrement: 1, minGapBetweenBidsMs: 0 } } });
  t.after(async () => { await engine.stop(); f.close(); });
  const state = await engine.scan();
  assert.equal(state.plans.length, 1, 'cash reserve permits only one 100-coin plan');
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(posts.length, 0, 'changed live bid is above cap');
});

test('dry-run proposals retain a clearly counterfactual outcome after settlement', async (t) => {
  const f = fixture(t);
  for (const price of [750, 800, 850, 900]) f.sold(ID.a, price);
  const endAt = Date.now() + 1200;
  const id = f.listing(ID.a, 100, { endAt, old: true });
  let status = 'active', posts = 0;
  const session = { hasCookie: () => true, userId: () => 'mine', async request(method, endpoint) {
    if (endpoint === '/api/wikibidous') return { status: 200, json: { balance: 10_000 } };
    if (method === 'POST') { posts++; throw new Error('dry run made a site write'); }
    return { status: 200, json: { auction: { id, card_id: ID.a, snapshot_rarity: 'UR',
      is_shiny: false, seller_id: 'other', base_amount: 100, current_bid: status === 'active' ? null : 150,
      effective_bid: 100, current_bidder_id: status === 'active' ? null : 'rival',
      end_at: new Date(endAt).toISOString(), status, final_price: status === 'active' ? null : 150,
      winner_id: status === 'active' ? null : 'rival', card: { wikipedia_title: 'Card', rarity: 'UR' } } } };
  } };
  const { engine, store } = setup(t, f.dbPath, { session, config: { buy: {
    enabled: true, minSold: 4, topCount: 5000, minProfit: 200,
    exitProbability: 0.8, reserveCoins: 1000, reserveFraction: 0.5,
    scanSeconds: 45, freshLookbackMinutes: 60, topRefreshMinutes: 30,
    maxRowsPerScan: 5000, maxQuotesPerScan: 60, targetRemainingMs: 350,
    preCheckLeadMs: 250, extraBidLatencyMs: 0,
    maxCounters: 2, bidIncrement: 1, minGapBetweenBidsMs: 0 } } });
  t.after(async () => { await engine.stop(); f.close(); });
  await engine.scan();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(store.data.bids[id]?.status, 'dry-pending');
  assert.equal(posts, 0);
  status = 'settled_sold';
  await engine.reconcile();
  assert.equal(store.data.bids[id].status, 'dry-outcome');
  assert.equal(store.data.bids[id].finalPrice, 150);
  assert.equal(store.data.bids[id].estimatedWouldWin, false, 'a 100-coin proposal did not beat the recorded final price');
  assert.equal(store.events.find((event) => event.type === 'deal-dry-outcome')?.counterfactual, true);
});

test('outbid hold is recorded as refunded once and then reconciles to lost', async (t) => {
  const f = fixture(t);
  for (const price of [750, 800, 850, 900]) f.sold(ID.a, price);
  const endAt = Date.now() + 4000;
  const id = f.listing(ID.a, 100, { endAt, old: true });
  let leading = false, settled = false;
  const session = { hasCookie: () => true, userId: () => 'mine', async request(method, endpoint) {
    if (endpoint === '/api/wikibidous') return { status: 200, json: { balance: leading ? 9900 : 10_000 } };
    if (method === 'POST') { leading = true; return { status: 200,
      json: { current_bid: 100, bidder_balance: 9900 } }; }
    return { status: 200, json: { auction: { id, card_id: ID.a, snapshot_rarity: 'UR',
      is_shiny: false, seller_id: 'other', base_amount: 100,
      current_bid: leading ? (settled ? 150 : 100) : null,
      effective_bid: 100, current_bidder_id: leading ? (settled ? 'rival' : 'mine') : null,
      end_at: new Date(endAt).toISOString(), status: settled ? 'settled_sold' : 'active',
      final_price: settled ? 150 : null, winner_id: settled ? 'rival' : null,
      card: { wikipedia_title: 'Card', rarity: 'UR' } } } };
  } };
  const portfolio = { balance: 10_000, cutoff: 0, queueDepth: 0,
    slots: { max: 5 }, inventory: [], dry: false, paused: false };
  const { engine, store } = setup(t, f.dbPath, { session, portfolio, liveRequested: true,
    config: { dryRun: false, buy: { enabled: true, minSold: 4, topCount: 5000,
      minProfit: 200, exitProbability: 0.8, reserveCoins: 1000, reserveFraction: 0.5,
      scanSeconds: 45, freshLookbackMinutes: 60, topRefreshMinutes: 30,
      maxRowsPerScan: 5000, maxQuotesPerScan: 60, targetRemainingMs: 3500,
      preCheckLeadMs: 250, extraBidLatencyMs: 0,
      maxCounters: 0, bidIncrement: 1, minGapBetweenBidsMs: 0 } } });
  t.after(async () => { await engine.stop(); f.close(); });
  await engine.scan();
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(store.data.bids[id]?.status, 'leading');
  settled = true;
  await engine.reconcile();
  await engine.reconcile();
  assert.equal(store.data.bids[id].status, 'lost');
  assert.equal(store.data.bids[id].refundedAmount, 100);
  assert.equal(store.events.filter((event) => event.type === 'deal-refund-observed').length, 1);
});

test('hybrid pool permanently includes proven affordable variants and retains expensive opportunities', async (t) => {
  const f = fixture(t);
  for (const price of [660, 750, 850, 900]) f.sold(ID.a, price);
  for (const price of [160, 180, 190, 200, 210, 220, 230, 240]) f.sold(ID.b, price);
  for (const price of [900, 950, 1000]) f.sold(ID.c, price);
  const premiumId = f.listing(ID.a, 25, { old: true });
  const liquidId = f.listing(ID.b, 25, { old: true });
  f.listing(ID.c, 25);
  const { engine } = setup(t, f.dbPath, { config: { buy: hybridBuy },
    model: { dealQuote: async ({ cardId }) => hybridQuote(cardId === ID.b ? 'liquid' : 'premium') } });
  t.after(async () => { await engine.stop(); f.close(); });
  const state = await engine.scan();
  assert.deepEqual(new Set(state.candidates.map((item) => item.auctionId)), new Set([premiumId, liquidId]));
  assert.equal(state.discovery.liquidVariants, 1);
  assert.equal(state.candidates.find((item) => item.auctionId === liquidId).minProfit, 15);
  assert.equal(state.candidates.find((item) => item.auctionId === premiumId).safeExit, 660);
  assert.equal(state.plans.length, 0, 'distant watches do not reserve buying cash');
  assert.equal((await engine.scan()).watchCount, 2, 'affordable pool survives the recent-feed cursor');
});

test('verification rejection preserves the watch, blocks further bids, and recovers after owner retry', async (t) => {
  const f = fixture(t);
  let endAt = Date.now() + 6000, blocked = true, leading = false, posts = 0;
  const id = 'verification-auction';
  const discovery = { async call() { return scanResult([observed(id, ID.a, endAt)]); }, async close() {} };
  let notifyPost;
  const firstPost = new Promise((resolve) => { notifyPost = resolve; });
  const session = { hasCookie: () => true, userId: () => 'mine', async request(method, endpoint) {
    if (endpoint === '/api/wikibidous') return { status: 200, json: { balance: 10_000 } };
    if (method === 'POST') {
      posts++; notifyPost();
      if (blocked) return { status: 403, json: { error: 'Vérification anti-bot requise.' } };
      leading = true;
      return { status: 200, json: { current_bid: 25, bidder_balance: 9975 } };
    }
    return { status: 200, json: { auction: { id, card_id: ID.a, snapshot_rarity: 'UR',
      is_shiny: false, seller_id: 'other', base_amount: 25, current_bid: leading ? 25 : null,
      current_bidder_id: leading ? 'mine' : null, end_at: new Date(endAt).toISOString(),
      status: 'active', card: { wikipedia_title: 'Card', rarity: 'UR' } } } };
  } };
  const portfolio = { balance: 10_000, slots: { max: 5 }, inventory: [], dry: false, paused: false };
  const { engine, store } = setup(t, f.dbPath, { session, portfolio, discovery,
    liveRequested: true, model: { dealQuote: async () => hybridQuote() },
    config: { dryRun: false, buy: { ...hybridBuy, targetRemainingMs: 4500, preCheckLeadMs: 0 } } });
  t.after(async () => { await engine.stop(); f.close(); });
  await engine.scan();
  await firstPost;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.data.dealWatchlist[id].status, 'verification-blocked');
  assert.equal(store.data.bids[id], undefined);
  assert.equal(engine.getState().verificationBlocked, true);
  await engine.scan();
  assert.equal(engine.getState().plans.length, 0);
  assert.equal(posts, 1);
  // An extended auction can still be safely rechecked before another bid.
  endAt = Date.now() + 6000;
  store.data.dealWatchlist[id].endAt = endAt;
  store.data.dealWatchlist.expired = { ...observed('expired', ID.b, Date.now() - 1000), verificationBlocked: true, status: 'terminal' };
  store.data.dealWatchlist.alreadyBid = { ...observed('alreadyBid', ID.c), verificationBlocked: true, status: 'terminal' };
  store.data.bids.alreadyBid = { auctionId: 'alreadyBid', status: 'lost' };
  blocked = false;
  assert.equal(engine.retryVerification(['expired', 'alreadyBid']).recoveredAuctions, 1);
  await engine.scan();
  assert.equal(engine.getState().verificationBlocked, false);
  assert.equal(store.data.dealWatchlist.expired.status, 'terminal');
  assert.equal(store.data.dealWatchlist.alreadyBid.status, 'terminal');
  const deadline = Date.now() + 6000;
  while (posts < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(posts, 2);
  assert.equal(store.data.bids[id].status, 'leading');
});

test('persistent hybrid watches survive truncated scans and restart without noisy plan replacement', async (t) => {
  const f = fixture(t);
  let call = 0;
  const first = observed('persistent', ID.a);
  const discovery = { async call() { return scanResult(call++ ? [] : [first]); }, async close() {} };
  const model = { dealQuote: async () => hybridQuote() };
  const setupOne = setup(t, f.dbPath, { discovery, model, config: { buy: hybridBuy } });
  const { engine, store, config, portfolio } = setupOne;
  t.after(async () => { await engine.stop(); f.close(); });
  const original = await engine.scan();
  const originalPlan = original.plans[0];
  const repeated = await engine.scan();
  assert.equal(repeated.plans[0].createdAt, originalPlan.createdAt);
  assert.equal(repeated.plans[0].fireAt, originalPlan.fireAt);
  assert.equal(store.events.filter((event) => event.type === 'deal-planned').length, 1);
  assert.ok(!store.events.some((event) => /left the queue/.test(event.reason ?? '')));
  await engine.stop();
  const restarted = setup(t, f.dbPath, { discovery, model, store, portfolio, config });
  t.after(() => restarted.engine.stop());
  assert.equal((await restarted.engine.scan()).plans[0].auctionId, first.auctionId);
});

test('hybrid quote work and near-term plan capacity are separate and fair between lanes', async (t) => {
  const f = fixture(t);
  const at = Date.now() + 300_000;
  let call = 0;
  const rows = [observed('p1', ID.a, at), observed('p2', ID.c, at + 1000),
    observed('l1', ID.b, at, 'liquid'), observed('l2', ID.d, at + 1000, 'liquid')];
  const quotes = [];
  const discovery = { async call() { return scanResult(call++ ? [] : rows); }, async close() {} };
  const { engine } = setup(t, f.dbPath, { discovery, config: { buy: { ...hybridBuy, maxQuotesPerScan: 2, maxPlans: 2 } },
    model: { async dealQuote({ cardId }) { quotes.push(cardId); return hybridQuote([ID.b, ID.d].includes(cardId) ? 'liquid' : 'premium'); } } });
  t.after(async () => { await engine.stop(); f.close(); });
  const one = await engine.scan();
  assert.deepEqual(quotes, [ID.a, ID.b]);
  assert.equal(one.watchCount, 4);
  assert.equal(one.plans.length, 2);
  const two = await engine.scan();
  assert.deepEqual(quotes, [ID.a, ID.b, ID.c, ID.d]);
  assert.deepEqual(two.plans.map((item) => item.auctionId), one.plans.map((item) => item.auctionId));
  assert.equal(two.readyCount, 4);
});

test('a capacity rejection clears when a still-approved row can be funded without requoting', async (t) => {
  const f = fixture(t), at = Date.now() + 300_000;
  const rows = [observed('blocked', ID.a, at), observed('rotation', ID.b, at)];
  const discovery = { async call() { return scanResult(rows); }, async close() {} };
  const store = { data: { purchases: { held: { status: 'inventory', purchasePrice: 20 } } },
    events: [], save() {}, record(type, fields) { this.events.push({ type, ...fields }); } };
  const { engine } = setup(t, f.dbPath, { discovery, store,
    config: { buy: { ...hybridBuy, maxQuotesPerScan: 1, maxResaleExposure: 1 } },
    model: { dealQuote: async () => hybridQuote() } });
  t.after(async () => { await engine.stop(); f.close(); });
  assert.equal((await engine.scan()).plans.length, 0);
  assert.equal(store.data.dealWatchlist.blocked.status, 'ready');
  assert.match(store.data.dealWatchlist.blocked.reason, /capacity/);
  const approvedAt = store.data.dealWatchlist.blocked.lastEvaluatedAt;
  store.data.purchases.held.status = 'sold';
  const next = await engine.scan();
  assert.equal(store.data.dealWatchlist.blocked.lastEvaluatedAt, approvedAt, 'another row used the quote budget');
  assert.equal(next.plans[0].auctionId, 'blocked');
  assert.equal(store.data.dealWatchlist.blocked.reason, null);
  assert.ok(!store.events.some(e => e.type === 'deal-snipe-skipped' && /capacity/.test(e.reason)));
});

test('aging near-end auctions are quoted before a distant backlog without starving fresh rotation', async (t) => {
  const f = fixture(t), clockAt = Date.now();
  let time = clockAt;
  const rows = [observed('far', ID.a, clockAt + 3600_000), observed('ending', ID.b, clockAt + 120_000)];
  const discovery = { async call() { return scanResult(rows); }, async close() {} };
  const quotes = [];
  const { engine, store } = setup(t, f.dbPath, { discovery, now: () => time,
    config: { buy: { ...hybridBuy, planningHorizonMinutes: 3, liveRefreshLeadSeconds: 180, maxQuotesPerScan: 1 } },
    model: { dealQuote: async ({ cardId }) => { quotes.push(cardId); return hybridQuote(); } } });
  t.after(async () => { await engine.stop(); f.close(); });
  await engine.scan();
  assert.deepEqual(quotes, [ID.b], 'ending auction does not wait behind the distant first feed row');
  assert.equal(engine.getState().plans[0].auctionId, 'ending');
  await engine.scan();
  assert.deepEqual(quotes, [ID.b, ID.a], 'fresh urgent approval yields to the ordinary rotation');
  time += 61_000;
  store.data.dealWatchlist.far.lastEvaluatedAt = 1;
  await engine.scan();
  assert.deepEqual(quotes, [ID.b, ID.a, ID.b], 'urgent refresh wins over the older distant quote');
  assert.equal(engine.getState().lastScanDurationMs, 0);
});

test('a rejected live price survives stale discovery and cannot recreate a cheap funded plan', async (t) => {
  const f = fixture(t), endAt = Date.now() + 8000;
  const listing = observed('moved-live', ID.a, endAt);
  const discovery = { async call() { return scanResult([listing]); }, async close() {} };
  let notifySkipped;
  const skipped = new Promise(resolve => { notifySkipped = resolve; });
  const store = { data: {}, events: [], save() {}, record(type, fields) {
    this.events.push({ type, ...fields }); if (type === 'deal-snipe-skipped') notifySkipped();
  } };
  const session = { hasCookie: () => true, userId: () => 'mine', async request(method, endpoint) {
    assert.equal(method, 'GET', 'over-cap live price must never POST');
    assert.equal(endpoint, '/api/marketplace/moved-live');
    return { status: 200, json: { auction: { id: listing.auctionId, card_id: ID.a,
      snapshot_rarity: 'UR', is_shiny: false, seller_id: 'other', base_amount: 25,
      current_bid: 100, end_at: new Date(endAt).toISOString(), status: 'active', card: { rarity: 'UR' } } } };
  } };
  const portfolio = { balance: 10000, inventory: [], slots: { max: 5 }, dry: false, paused: false };
  const { engine } = setup(t, f.dbPath, { discovery, store, session, portfolio, liveRequested: true,
    config: { dryRun: false, buy: { ...hybridBuy, targetRemainingMs: 7000, preCheckLeadMs: 0 } },
    model: { dealQuote: async () => hybridQuote('premium', 50) } });
  t.after(async () => { await engine.stop(); f.close(); });
  await engine.scan(); await skipped;
  assert.equal(store.data.dealWatchlist[listing.auctionId].currentBid, 100);
  assert.equal(store.data.dealWatchlist[listing.auctionId].status, 'price-too-high');
  assert.ok(store.data.dealWatchlist[listing.auctionId].lastLiveAt > 0);
  const again = await engine.scan();
  assert.equal(again.plans.length, 0);
  assert.equal(store.data.dealWatchlist[listing.auctionId].amount, 110);
  assert.equal(store.events.filter(e => e.type === 'deal-planned').length, 1);
});

test('a changed required bid invalidates an old approval outside the current quote budget', async (t) => {
  const f = fixture(t), endAt = Date.now() + 300_000;
  let moved = false;
  const discovery = { async call() { return scanResult([
    { ...observed('pesquet', ID.a, endAt), baseAmount: moved ? 1431 : 1,
      currentBid: moved ? 1431 : null, amount: moved ? 1575 : 1 },
    observed('other', ID.b, endAt),
  ]); }, async close() {} };
  const { engine, store } = setup(t, f.dbPath, { discovery,
    config: { buy: { ...hybridBuy, maxQuotesPerScan: 1 } },
    model: { async dealQuote() { return { ...hybridQuote('premium', 690), stressedValue: 794,
      expectedFees: 0, slotCost: 0, reason: undefined }; } } });
  t.after(async () => { await engine.stop(); f.close(); });
  await engine.scan(); await engine.scan();
  assert.ok(engine.getState().plans.some(plan => plan.auctionId === 'pesquet'));
  store.data.dealWatchlist.other.lastEvaluatedAt = -1;
  moved = true;
  const state = await engine.scan();
  const row = state.candidates.find(item => item.auctionId === 'pesquet');
  assert.equal(row.amount, 1575);
  assert.equal(row.maxBid, 690);
  assert.equal(row.status, 'price-too-high');
  assert.equal(row.cautiousProfit, null);
  assert.ok(!state.plans.some(plan => plan.auctionId === 'pesquet'));
  assert.ok(state.plans.every(plan => plan.amount <= plan.maxBid));
  await engine.scan();
  assert.equal(engine.getState().candidates.find(item => item.auctionId === 'pesquet').status, 'price-too-high',
    'an undefined quote reason cannot overwrite the over-cap rejection');
  assert.ok(engine.getState().candidates.find(item => item.auctionId === 'pesquet').cautiousProfit < 0,
    'the fresh margin uses the actual required bid, not its old cheap price');
});

test('restart retains watches but never funds old ready rows without a fresh approval', async (t) => {
  const f = fixture(t), endAt = Date.now() + 300_000;
  const stale = { ...observed('old', ID.a, endAt), status: 'ready', amount: 1575,
    maxBid: 690, cautiousProfit: 793, lastEvaluatedAt: 1, minProfit: 75 };
  const store = { data: { dealWatchlist: { old: stale, first: { ...observed('first', ID.b, endAt),
    status: 'watching', lastEvaluatedAt: -1 } } }, save() {}, record() {} };
  const discovery = { async call() { return scanResult([]); }, async close() {} };
  const { engine } = setup(t, f.dbPath, { discovery, store,
    config: { buy: { ...hybridBuy, maxQuotesPerScan: 1, premiumMinProfit: 200 } },
    model: { async dealQuote() { return { reason: 'insufficient exact history' }; } } });
  t.after(async () => { await engine.stop(); f.close(); });
  const state = await engine.scan();
  assert.equal(state.watchCount, 2);
  assert.equal(state.plans.length, 0);
  assert.equal(state.candidates.find(item => item.auctionId === 'old').status, 'watching');
});

test('five-slot capacity counts all bought stock and commitments and funds the best slot return', async (t) => {
  const f = fixture(t), at = Date.now() + 300_000;
  const rows = [observed('small', ID.a, at, 'liquid'), observed('best', ID.b, at + 1000), observed('other', ID.c, at)];
  const discovery = { async call() { return scanResult(rows); }, async close() {} };
  const store = { data: { purchases: {
    first: { auctionId: 'old-first', purchasePrice: 10, status: 'inventory' },
    missingReturn: { auctionId: 'old-second', purchasePrice: 10, status: 'inventory' },
    sold: { auctionId: 'old-sold', purchasePrice: 10, status: 'sold' },
  }, bids: {
    'old-first': { auctionId: 'old-first', status: 'won', userCardId: 'first', amount: 10 },
    held: { auctionId: 'held', status: 'leading', amount: 10 },
    pending: { auctionId: 'pending', status: 'won', amount: 10 },
  } }, events: [], save() {}, record(type, fields) { this.events.push({ type, ...fields }); } };
  const { engine } = setup(t, f.dbPath, { discovery, store,
    config: { buy: { ...hybridBuy, maxPlans: 100, maxResaleExposure: 5, minSold: 8 } },
    model: { async dealQuote({ cardId }, options) {
      assert.equal(options.premiumThreshold.minSold, 8);
      return { ...hybridQuote(cardId === ID.a ? 'liquid' : 'premium'),
        stressedValue: cardId === ID.b ? 1000 : 200, expectedSlotHours: 2 };
    } } });
  t.after(async () => { await engine.stop(); f.close(); });
  const state = await engine.scan();
  assert.equal(state.plans.length, 1);
  assert.equal(state.plans[0].auctionId, 'best', 'profit per selling hour wins over earlier small deals');
  assert.equal(state.resaleExposure, 5);
  assert.equal(state.resaleCapacity, 5);
  assert.equal(state.watchCount, 3, 'unfunded candidates remain watched');
  store.data.purchases.new = { auctionId: 'external-win', status: 'inventory', purchasePrice: 10 };
  engine.pause();
  assert.equal(engine.getState().resaleExposure, 5);
  engine.resume();
  await engine.scan();
  assert.equal(engine.getState().plans.length, 0, 'no new commitments while bought stock and held bids fill capacity');
});

test('several auctions for one exact variant share a single funded purchase plan', async (t) => {
  const f = fixture(t);
  const at = Date.now() + 300_000;
  const discovery = { async call() { return scanResult([observed('first', ID.a, at),
    observed('later-copy', ID.a, at + 1000), observed('different', ID.b, at + 2000, 'liquid')]); }, async close() {} };
  const { engine } = setup(t, f.dbPath, { discovery, config: { buy: hybridBuy },
    model: { dealQuote: async ({ cardId }) => hybridQuote(cardId === ID.b ? 'liquid' : 'premium') } });
  t.after(async () => { await engine.stop(); f.close(); });
  const state = await engine.scan();
  assert.equal(state.watchCount, 3);
  assert.equal(state.plans.length, 2);
  assert.equal(state.plans.filter((plan) => plan.cardId === ID.a).length, 1);
  assert.equal(state.planned, 50);
});

test('hybrid pricing rechecks new own outcomes and rejects variants already held for resale', async (t) => {
  const f = fixture(t);
  const at = Date.now() + 300_000;
  const rows = [observed('p', ID.a, at), observed('owned', ID.b, at, 'liquid'), observed('unknown', ID.c, at)];
  let calls = 0, rejectedCalls = 0;
  const discovery = { async call() { return scanResult(rows); }, async close() {} };
  const portfolio = { balance: 10_000, cutoff: 0, queueDepth: 0, slots: { max: 5 }, dry: true,
    inventory: [{ userCardId: 'copy', cardId: ID.b, rarity: 'UR', shiny: false }] };
  const { engine, store } = setup(t, f.dbPath, { discovery, portfolio, config: { buy: hybridBuy },
    model: { async dealQuote({ cardId }, options) {
      if (cardId === ID.c) { rejectedCalls++; return { reason: 'insufficient exact-variant sales' }; }
      calls++;
      assert.deepEqual(options.slots, { max: 5 });
      return hybridQuote('premium', options.ownOutcomes.length ? 20 : 500);
    } } });
  t.after(async () => { await engine.stop(); f.close(); });
  assert.equal((await engine.scan()).plans.length, 1);
  assert.equal((await engine.scan()).plans.length, 1);
  assert.equal(calls, 1, 'identical portfolio and outcomes reuse the exact-variant quote');
  assert.equal(rejectedCalls, 1, 'unsupported variants also reuse their statistical rejection');
  store.data.listings = { failed: { cardId: ID.a, rarity: 'UR', shiny: false,
    createdAt: Date.now() - 1000, endAt: Date.now(), price: 660, status: 'settled_unsold' } };
  const changed = await engine.scan();
  assert.equal(calls, 2, 'a completed resale invalidates cached buying economics');
  assert.equal(changed.plans.length, 0);
  assert.ok(changed.rejections.some((item) => /already held for resale/.test(item.reason)));
  assert.ok(changed.rejections.some((item) => /insufficient exact-variant/.test(item.reason)));
});

test('hybrid live terminal outcomes are durable and resale economics follow matched purchases', async (t) => {
  const f = fixture(t);
  const endAt = Date.now() + 60_000;
  const candidate = observed('settled', ID.a, endAt);
  let reads = 0;
  const discovery = { async call() { return scanResult([candidate]); }, async close() {} };
  const session = { hasCookie: () => true, userId: () => 'mine', async request() {
    reads++;
    return { status: 200, json: { auction: { id: candidate.auctionId, card_id: ID.a,
      snapshot_rarity: 'UR', is_shiny: false, seller_id: 'other', base_amount: 25,
      end_at: new Date(endAt).toISOString(), status: 'settled_sold', winner_id: 'rival',
      final_price: 700, card: { rarity: 'UR' } } } };
  } };
  const { engine, store, portfolio } = setup(t, f.dbPath, { session, discovery,
    config: { buy: { ...hybridBuy, maxLiveRefreshPerScan: 12, liveRequestGapMs: 0 } },
    model: { dealQuote: async () => hybridQuote() } });
  t.after(async () => { await engine.stop(); f.close(); });
  assert.equal((await engine.scan()).watchCount, 0);
  assert.equal((await engine.scan()).watchCount, 0);
  assert.equal(reads, 1, 'a stale database row cannot resurrect a confirmed terminal auction');
  const quote = hybridQuote();
  store.data.bids.won = { auctionId: 'won', cardId: ID.b, title: 'Bought', rarity: 'UR', shiny: false,
    amount: 25, purchasePrice: 25, status: 'won', ownedBeforeIds: [], ...quote };
  portfolio.inventory = [{ userCardId: 'new', cardId: ID.b, rarity: 'UR', shiny: false }];
  await engine.reconcile();
  assert.deepEqual(store.data.purchases.new.resalePlan, quote.resalePlan);
  assert.equal(store.data.purchases.new.minProfit, 75);
  assert.equal(store.data.purchases.new.lane, 'premium');
});

test('final spending checks are serialized across simultaneous plans', async (t) => {
  const f = fixture(t);
  const endAt = Date.now() + 2500;
  for (const price of [750, 800, 850, 900]) { f.sold(ID.a, price); f.sold(ID.b, price); }
  const a = f.listing(ID.a, 100, { endAt });
  const b = f.listing(ID.b, 100, { endAt });
  let balance = 300;
  const posts = [];
  const session = { hasCookie: () => true, userId: () => 'mine', async request(method, endpoint) {
    if (endpoint === '/api/wikibidous') return { status: 200, json: { balance } };
    const id = endpoint.split('/').at(method === 'POST' ? -2 : -1);
    if (method === 'POST') {
      posts.push(id);
      await new Promise((resolve) => setTimeout(resolve, 120));
      balance -= 160; // purchase plus an external spend while the request completes
      return { status: 200, json: { current_bid: 100, bidder_balance: balance } };
    }
    return { status: 200, json: { auction: { id, card_id: id === a ? ID.a : ID.b,
      snapshot_rarity: 'UR', is_shiny: false, seller_id: 'other', base_amount: 100,
      end_at: new Date(endAt).toISOString(), status: 'active', card: { rarity: 'UR' } } } };
  } };
  const portfolio = { balance: 300, cutoff: 0, queueDepth: 0, slots: { max: 5 }, inventory: [], dry: false };
  const { engine } = setup(t, f.dbPath, { session, portfolio, liveRequested: true,
    config: { dryRun: false, buy: { reserveCoins: 100, reserveFraction: 0, targetRemainingMs: 2000 } } });
  t.after(async () => { await engine.stop(); f.close(); });
  assert.equal((await engine.scan()).plans.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(posts.length, 1, 'second final balance sees the first spend and preserves the reserve');
  assert.equal(balance, 140);
});

test('hybrid deadline budget prevents POST when final reads consume the remaining window', async (t) => {
  const f = fixture(t);
  let at = Date.now();
  const endAt = at + 3000;
  const candidate = observed('slow', ID.a, endAt);
  let reads = 0, posts = 0;
  const discovery = { async call() { return scanResult([candidate]); }, async close() {} };
  const session = { hasCookie: () => true, userId: () => 'mine', async request(method, endpoint) {
    if (method === 'POST') { posts++; return { status: 200, json: { current_bid: 25 } }; }
    if (endpoint === '/api/wikibidous') { at += 900; return { status: 200, json: { balance: 10_000 } }; }
    reads++;
    at += reads === 1 ? 900 : 1000;
    return { status: 200, json: { auction: { id: candidate.auctionId, card_id: ID.a,
      snapshot_rarity: 'UR', is_shiny: false, seller_id: 'other', base_amount: 25,
      end_at: new Date(endAt).toISOString(), status: 'active', card: { rarity: 'UR' } } } };
  } };
  const portfolio = { balance: 10_000, cutoff: 0, queueDepth: 0, slots: { max: 5 }, inventory: [], dry: false };
  const { engine, store } = setup(t, f.dbPath, { now: () => at, session, discovery, portfolio, liveRequested: true,
    config: { dryRun: false, buy: { ...hybridBuy, targetRemainingMs: 2200 } },
    model: { dealQuote: async () => hybridQuote() } });
  t.after(async () => { await engine.stop(); f.close(); });
  await engine.scan();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(posts, 0);
  assert.ok(store.events.some((event) => /insufficient time/.test(event.reason ?? '')));
});
