import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMarketModel, MarketModel, quoteHybridResale } from '../src/model.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-money-model-'));
  const dbPath = path.join(dir, 'market.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE auctions (
    id TEXT PRIMARY KEY, card_id TEXT, seller_id TEXT, rarity TEXT, is_shiny INTEGER,
    q_score REAL, pageviews INTEGER, listing_base_amount INTEGER, base_repriced_at INTEGER,
    status TEXT, final_price INTEGER, end_at INTEGER, final INTEGER
  ); CREATE INDEX auctions_card ON auctions(card_id);`);
  const insert = db.prepare(`INSERT INTO auctions (id, card_id, seller_id, rarity, is_shiny,
    q_score, pageviews, listing_base_amount, base_repriced_at, status, final_price, end_at, final)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let next = 0;
  function add({ cardId = `peer-${next}`, sellerId = `seller-${next}`, rarity = 'C',
    shiny = 0, qScore = 50, pageviews = 100, price = 1, sold = false,
    finalPrice = price, endAt = 100, repriced = false } = {}) {
    insert.run(`auction-${next++}`, cardId, sellerId, rarity, shiny, qScore, pageviews,
      price, repriced ? 90 : null, sold ? 'settled_sold' : 'settled_unsold',
      sold ? finalPrice : null, endAt, 1);
  }
  return { db, dbPath, add, dispose: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('closing an unready model cancels initialization without leaking a worker or an unhandled rejection', async () => {
  const f = fixture();
  f.add({ sold: true });
  const model = new MarketModel({ dbPath: f.dbPath });
  try {
    await model.close();
    await assert.rejects(model.ready(), /closed/);
    assert.equal(model.closed, true);
  } finally { await model.close(); f.dispose(); }
});

test('model restarts reuse fresh calibration but reject future and stale cached windows', async () => {
  const f = fixture();
  f.add({ sold: true, endAt: 90000000 });
  f.add({ sold: true, endAt: 100000000 });
  const calibrationCachePath = path.join(path.dirname(f.dbPath), 'calibration.json');
  let model;
  try {
    model = await createMarketModel({ dbPath: f.dbPath, calibrationCachePath });
    assert.equal((await model.health()).premiumCalibrationReused, false);
    await model.close();
    model = await createMarketModel({ dbPath: f.dbPath, calibrationCachePath });
    assert.equal((await model.health()).premiumCalibrationReused, true);
    await model.close();
    model = await createMarketModel({ dbPath: f.dbPath, calibrationCachePath, maxEndAt: 95000000 });
    assert.equal((await model.health()).premiumCalibrationReused, false);
    assert.equal(JSON.parse(fs.readFileSync(calibrationCachePath, 'utf8')).calibration.windowEnd, 100000000,
      'an as-of evaluation cannot overwrite the current live cache');
    await model.close();
    f.add({ sold: true, endAt: 100000000 + 7 * 3_600_000 });
    model = await createMarketModel({ dbPath: f.dbPath, calibrationCachePath });
    assert.equal((await model.health()).premiumCalibrationReused, false);
    assert.equal((await model.health()).premiumCalibration.windowEnd, 100000000 + 7 * 3_600_000);
  } finally { await model?.close(); f.dispose(); }
});

test('purchase auction history is read-only, exact, account-scoped and reads newly recorded sales', async () => {
  const f = fixture();
  f.db.exec('ALTER TABLE auctions ADD COLUMN created_at INTEGER; ALTER TABLE auctions ADD COLUMN settled_at INTEGER;');
  f.add({ cardId: 'purchased', sellerId: 'me', sold: true, endAt: 5000, finalPrice: 25 });
  f.add({ cardId: 'purchased', sellerId: 'other', sold: true, endAt: 5000 });
  f.add({ cardId: 'purchased', sellerId: 'me', shiny: 1, sold: true, endAt: 5000 });
  f.db.exec('UPDATE auctions SET created_at = 2000, settled_at = 5001');
  const model = await createMarketModel({ dbPath: f.dbPath });
  try {
    const purchases = [{ cardId: 'purchased', rarity: 'C', shiny: false, purchasedAt: 1000 }];
    const rows = await model.purchaseAuctions('me', purchases);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].final_price, 25);
    assert.equal(Date.parse(rows[0].created_at), 2000);
    assert.equal((await model.purchaseAuctions('me', [{ ...purchases[0], purchasedAt: 3000 }])).length, 0);
    f.add({ cardId: 'purchased', sellerId: 'me', sold: true, endAt: 9000 });
    f.db.exec("UPDATE auctions SET created_at = 7000 WHERE id = 'auction-3'");
    assert.equal((await model.purchaseAuctions('me', purchases)).length, 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auctions').get().n, 4);
  } finally { await model.close(); f.dispose(); }
});

const hybridNow = Date.parse('2026-10-04T16:00:00Z');
const hybridFacts = { cardId: 'hybrid-card', rarity: 'R', shiny: false };
function hybridHistory({ sold = 16, unsold = 4, finalPrice = 120, startPrice = 60, durationMinutes = 60 } = {}) {
  return Array.from({ length: sold + unsold }, (_, i) => ({ id: `hybrid-${i}`,
    card_id: hybridFacts.cardId, rarity: hybridFacts.rarity, is_shiny: 0,
    seller_id: `seller-${i % 4}`, winner_id: i < sold ? `buyer-${i % 6}` : null,
    listing_base_amount: startPrice, base_repriced_at: null,
    status: i < sold ? 'settled_sold' : 'settled_unsold', final_price: i < sold ? finalPrice : null,
    end_at: hybridNow - i * 60_000, created_at: hybridNow - i * 60_000 - durationMinutes * 60_000 }));
}

test('hybrid quotes support both proven price lanes and charge fees and occupied slots', () => {
  const options = { now: hybridNow };
  const liquid = quoteHybridResale(hybridHistory(), hybridFacts, options);
  const premium = quoteHybridResale(hybridHistory({ finalPrice: 1200, startPrice: 600 }), hybridFacts, options);
  assert.equal(liquid.reason, undefined);
  assert.equal(premium.reason, undefined);
  assert.equal(liquid.lane, 'liquid');
  assert.equal(premium.lane, 'premium');
  assert.equal(liquid.minProfit, 15);
  assert.equal(premium.minProfit, 75);
  assert.ok(liquid.safeExit <= Math.min(liquid.p25, liquid.median * 0.85));
  assert.ok(liquid.maxBid <= liquid.safeExit * 0.8);
  assert.ok(liquid.horizonP >= 0.8 && liquid.horizonP > liquid.exitP);
  const costlier = quoteHybridResale(hybridHistory(), hybridFacts, { ...options,
    listingFee: 2, cutoff: 2, queueDepth: 20, slots: { max: 5, free: 0 } });
  assert.ok(costlier.maxBid < liquid.maxBid);
  assert.ok(costlier.expectedFees > 2);
  assert.ok(costlier.slotCost > 2);
  assert.equal(liquid.resalePlan.ask, liquid.safeExit);
  assert.equal(liquid.resalePlan.attemptLimit, 6);
});

test('cheap acquisition quotes budget for lower opening bids without bidder uplift', () => {
  const quote = (history, ratio) => quoteHybridResale(history, hybridFacts,
    { now: hybridNow, buy: { liquidResaleAskRatio: ratio } });
  const cheaper = quote(hybridHistory(), 0.8), original = quote(hybridHistory(), 1);
  assert.ok(cheaper.safeExit <= Math.floor(Math.min(cheaper.p25, cheaper.median * 0.85) * 0.8));
  assert.ok(cheaper.maxBid < original.maxBid);
  assert.equal(cheaper.resalePlan.openingAskRatio, 0.8);
  const expensive = hybridHistory({ finalPrice: 1200, startPrice: 600 });
  assert.equal(quote(expensive, 0.8).safeExit, quote(expensive, 1).safeExit);
  assert.equal(quote(expensive, 0.8).maxBid, quote(expensive, 1).maxBid);
});

test('selective pricing pays for scarce selling hours and excludes unsold-stock credit', () => {
  const history = hybridHistory({ sold: 120, unsold: 0, finalPrice: 1200, startPrice: 400 });
  const buy = { minSold: 8, premiumMinProfit: 200, premiumMinRoi: 0.35,
    horizonProbability: 0.9, probabilityRiskWeight: 0.65, minAttemptProbability: 0.65,
    minProfitPerSlotHour: 50, slotOpportunityCoinsPerHour: 25, residualValueRatio: 0, maxBuyRatio: 0.6 };
  const quote = quoteHybridResale(history, hybridFacts, { now: hybridNow, buy, slots: { max: 5, free: 0 }, queueDepth: 5 });
  assert.equal(quote.reason, undefined);
  assert.ok(quote.horizonP >= 0.9);
  assert.ok(quote.chosen.riskAdjustedP >= 0.65);
  assert.equal(quote.residualValue, 0);
  assert.ok(quote.slotCost >= 25 * quote.expectedSlotHours);
  assert.ok(quote.chosen.mu - quote.maxBid >= Math.max(200, 50 * quote.expectedSlotHours));
  assert.ok((quote.chosen.mu - quote.maxBid) / quote.maxBid >= 0.35);
  const stricter = quoteHybridResale(history, hybridFacts, { now: hybridNow,
    buy: { ...buy, minProfitPerSlotHour: 500 }, slots: { max: 5, free: 0 }, queueDepth: 5 });
  assert.ok((stricter.maxBid ?? 0) < quote.maxBid);
});

test('hybrid rejects unknown, thin, concentrated and wrong-duration demand', () => {
  assert.match(quoteHybridResale([], hybridFacts, { now: hybridNow }).reason, /insufficient/);
  assert.match(quoteHybridResale(hybridHistory({ sold: 7 }), hybridFacts, { now: hybridNow }).reason, /sales/);
  const concentrated = hybridHistory().map((row) => ({ ...row, winner_id: 'same-buyer', seller_id: 'same-seller' }));
  assert.match(quoteHybridResale(concentrated, hybridFacts, { now: hybridNow }).reason, /buyers or sellers/);
  const longAuctions = hybridHistory({ durationMinutes: 720 });
  assert.match(quoteHybridResale(longAuctions, hybridFacts, { now: hybridNow }).reason, /listing duration/);
  const controlled = hybridHistory().map((row) => ({ ...row, seller_id: 'own-account' }));
  assert.equal(quoteHybridResale(controlled, hybridFacts, { now: hybridNow,
    controlledUserIds: ['own-account'] }).soldCount, 0);
});

test('hybrid own failures lower chance, deduplicate auction IDs and honor time and variant boundaries', () => {
  const rows = hybridHistory();
  const clean = quoteHybridResale(rows, hybridFacts, { now: hybridNow, askPrices: [60] });
  const own = { auctionId: 'own-failure', ...hybridFacts, status: 'settled_unsold',
    price: 60, createdAt: hybridNow - 3_600_000, endAt: hybridNow };
  const damaged = quoteHybridResale(rows, hybridFacts, { now: hybridNow, askPrices: [60], ownOutcomes: [own, own] });
  assert.ok(damaged.curve.find((point) => point.price === 60).p < clean.curve.find((point) => point.price === 60).p);
  assert.equal(damaged.evidence.ownOutcomesAdded, 1);
  const ignored = quoteHybridResale([...rows,
    ...hybridHistory({ finalPrice: 999999 }).map((row) => ({ ...row, end_at: hybridNow + 1 })),
    ...hybridHistory({ finalPrice: 999999 }).map((row) => ({ ...row, is_shiny: 1 }))], hybridFacts,
  { now: hybridNow, askPrices: [60], ownOutcomes: [{ ...own, auctionId: rows[0].id },
    { ...own, shiny: true }, { ...own, endAt: hybridNow + 1 }, { ...own, endAt: hybridNow - 15 * 86_400_000 }] });
  assert.equal(ignored.evidence.ownOutcomesAdded, 0);
  assert.equal(ignored.median, clean.median);
  assert.equal(ignored.soldCount, clean.soldCount);
  assert.equal(ignored.curve.find((point) => point.price === 60).p, clean.curve.find((point) => point.price === 60).p);
});

test('hybrid worker operation matches the exact-history policy', async () => {
  const f = fixture();
  f.db.exec('ALTER TABLE auctions ADD COLUMN winner_id TEXT; ALTER TABLE auctions ADD COLUMN created_at INTEGER;');
  for (const row of hybridHistory()) {
    f.add({ cardId: row.card_id, rarity: row.rarity, price: row.listing_base_amount,
      sold: row.status === 'settled_sold', finalPrice: row.final_price, endAt: row.end_at, sellerId: row.seller_id });
    f.db.prepare('UPDATE auctions SET winner_id = ?, created_at = ? WHERE card_id = ? AND end_at = ?')
      .run(row.winner_id, row.created_at, row.card_id, row.end_at);
  }
  const model = await createMarketModel({ dbPath: f.dbPath });
  try {
    const quote = await model.dealQuote(hybridFacts, { now: hybridNow });
    assert.equal(quote.reason, undefined);
    assert.equal(quote.lane, 'liquid');
    assert.equal(quote.buyers, 6);
    assert.equal(quote.sellers, 4);
    assert.ok(quote.maxBid > 0);
    assert.equal(quote.evidence.source, 'exact-card-hybrid');
  } finally { await model.close(); f.dispose(); }
});

test('cards with sales use only exact history and repeats have less weight', async () => {
  const f = fixture();
  const otherPeers = fixture();
  for (let i = 0; i < 200; i++) f.add({ price: 1, sold: i < 120, finalPrice: i < 120 ? 10 : undefined });
  for (let i = 0; i < 200; i++) f.add({ price: 5, sold: i < 90, finalPrice: 12 });
  for (let i = 0; i < 100; i++) f.add({ price: 20, sold: i < 15, finalPrice: 25 });
  f.add({ price: 1, sold: true, finalPrice: 100000 });
  for (let i = 0; i < 200; i++) otherPeers.add({ price: 100, sold: true, finalPrice: 500 });
  for (let i = 0; i < 5; i++) {
    f.add({ cardId: 'strong-card', price: 5, sold: true, finalPrice: 20 });
    otherPeers.add({ cardId: 'strong-card', price: 5, sold: true, finalPrice: 20 });
  }
  for (let i = 0; i < 5; i++) f.add({ cardId: 'weak-card', price: 5, sold: false });
  for (let i = 0; i < 5; i++) f.add({ cardId: 'repeat-card', sellerId: 'same-seller', price: 5, sold: false });
  f.add({ cardId: 'weak-card', price: 1, sold: true, finalPrice: 1000, repriced: true });
  const model = await createMarketModel({ dbPath: f.dbPath });
  const second = await createMarketModel({ dbPath: otherPeers.dbPath });
  try {
    const facts = (cardId) => ({ cardId, rarity: 'C', shiny: false, qScore: 50, pageviews: 100 });
    const [ordinary, strong, sameCardOtherPeers, weak, repeated] = await Promise.all([
      model.quote(facts('never-seen')), model.quote(facts('strong-card')),
      second.quote(facts('strong-card')), model.quote(facts('weak-card')),
      model.quote(facts('repeat-card')),
    ]);
    assert.equal(ordinary.curve.length, 0);
    assert.equal(weak.curve.length, 0);
    assert.equal(weak.evidence.rawSold, 0);
    assert.equal(repeated.evidence.rawUnsold, 5);
    assert.ok(repeated.evidence.effectiveN < 3);
    assert.ok(repeated.evidence.effectiveN > 2);
    assert.equal(strong.evidence.source, 'exact-card-only');
    assert.ok(strong.curve.every((p) => p.price <= 16 && p.meanProceeds <= 20));
    for (let i = 1; i < strong.curve.length; i++)
      assert.ok(strong.curve[i].p <= strong.curve[i - 1].p + 1e-9);
    assert.deepEqual(strong.curve, sameCardOtherPeers.curve);
    assert.equal((await model.health()).ready, true);
  } finally { await model.close(); await second.close(); f.dispose(); otherPeers.dispose(); }
});

test('an 80% preferred price is chosen before fallback and a chronological holdout is scored', async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.add({ rarity: 'L', price: 1, sold: i < 98, finalPrice: 100, endAt: 100 });
  for (let i = 0; i < 100; i++) f.add({ rarity: 'L', price: 100, sold: i < 30, finalPrice: 150, endAt: 100 });
  for (let i = 0; i < 40; i++) f.add({ rarity: 'L', price: 1, sold: i < 39, finalPrice: 100, endAt: 200 });
  const model = await createMarketModel({ dbPath: f.dbPath, maxEndAt: 150 });
  try {
    const q = await model.quote({ cardId: 'new-legendary', rarity: 'L', shiny: false,
      qScore: 50, pageviews: 100 }, { outcomePenalty: 0, modelLowerPenalty: 0 });
    assert.ok(q.chosen);
    assert.ok(q.targetMet);
    assert.ok(q.chosen.p >= 0.8);
    assert.ok(q.curve.find((x) => x.price === 1).p > q.curve.find((x) => x.price === 112).p);
    assert.equal(q.dataTimestamp, 100);
    const evaluation = await model.evaluateHoldout({ limit: 100 });
    assert.equal(evaluation.n, 40);
    assert.ok(evaluation.brier < 0.10);
    assert.ok(evaluation.logLoss < 0.40);
    assert.equal(evaluation.bins.reduce((sum, b) => sum + b.n, 0), 40);
  } finally { await model.close(); f.dispose(); }
});

test('an empty analyzer fails preflight before any inventory action', async () => {
  const f = fixture();
  try {
    await assert.rejects(createMarketModel({ dbPath: f.dbPath }), /no settled auction data/);
  } finally { f.dispose(); }
});

test('exact sales retain proceeds spread and repeated sales have lower effective count', async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.add({ rarity: 'R', price: 5, sold: true, finalPrice: 10 });
  for (let i = 0; i < 100; i++) f.add({ rarity: 'R', price: 5, sold: true, finalPrice: 20 });
  for (let i = 0; i < 100; i++) f.add({ rarity: 'R', price: 5, sold: false });
  for (let i = 0; i < 30; i++) f.add({ cardId: 'steady', rarity: 'R', price: 5, sold: true, finalPrice: 15 });
  for (let i = 0; i < 30; i++) f.add({ cardId: 'volatile', rarity: 'R', price: 5,
    sold: true, finalPrice: i % 2 ? 5 : 25 });
  for (let i = 0; i < 30; i++) f.add({ cardId: 'repeated', sellerId: 'one-seller',
    rarity: 'R', price: 5, sold: true, finalPrice: 15 });
  const model = await createMarketModel({ dbPath: f.dbPath });
  try {
    const facts = (cardId) => ({ cardId, rarity: 'R', shiny: false, qScore: 50, pageviews: 100 });
    const [steady, volatile, repeated] = await Promise.all([
      model.quote(facts('steady')), model.quote(facts('volatile')), model.quote(facts('repeated')),
    ]);
    const atOne = (q) => q.curve.find((point) => point.price === 1);
    assert.equal(steady.evidence.rawSoldPriceVariance, 0);
    assert.ok(volatile.evidence.rawSoldPriceVariance > 90);
    assert.ok(steady.evidence.priceVariance >= 0);
    assert.equal(atOne(steady).priceVariance, 0);
    assert.equal(atOne(repeated).priceVariance, 0);
    assert.ok(atOne(volatile).priceVariance > 0);
    assert.equal(repeated.evidence.independentSoldGroups, 1);
    assert.ok(repeated.evidence.effectiveSoldN < 10);
    assert.equal(steady.evidence.peerN, 0);
  } finally { await model.close(); f.dispose(); }
});

test('one exact sale at 30 cannot produce a peer-driven 112-coin asking price', async () => {
  const f = fixture();
  for (let i = 0; i < 200; i++) f.add({ price: 1, sold: i < 150, finalPrice: 300 });
  for (let i = 0; i < 200; i++) f.add({ price: 100, sold: i < 80, finalPrice: 300 });
  f.add({ cardId: 'low-sale', price: 1, sold: true, finalPrice: 30 });
  const model = await createMarketModel({ dbPath: f.dbPath });
  try {
    const q = await model.quote({ cardId: 'low-sale', rarity: 'C', shiny: false,
      qScore: 50, pageviews: 100 });
    assert.equal(q.evidence.rawSold, 1);
    assert.equal(q.evidence.observedSaleMedian, 30);
    assert.equal(q.evidence.maxSuggestedStart, 24);
    assert.ok(q.curve.every((p) => p.price <= 24 && p.meanProceeds <= 30));
    assert.ok(q.chosen?.price <= 24);
  } finally { await model.close(); f.dispose(); }
});

test('premium stats include repriced final sales and stay on the exact variant', async () => {
  const f = fixture();
  const prices = [600, 650, 700, 1000, 1200];
  for (let i = 0; i < prices.length; i++) f.add({ cardId: 'premium', rarity: 'R',
    price: Math.max(1, prices[i] - 100), sold: true, finalPrice: prices[i],
    repriced: i === 4, endAt: 100 + i });
  f.add({ cardId: 'premium', rarity: 'C', price: 1, sold: true, finalPrice: 1 });
  f.add({ cardId: 'premium', rarity: 'R', shiny: 1, price: 1, sold: true, finalPrice: 1 });
  const model = await createMarketModel({ dbPath: f.dbPath });
  try {
    const facts = { cardId: 'premium', rarity: 'R', shiny: false };
    const stats = await model.stats(facts);
    assert.equal(stats.soldCount, 5);
    assert.equal(stats.median, 700);
    assert.equal(stats.p25, 650);
    assert.equal(stats.lastSoldAt, 104);
    const ordinary = await model.quote(facts);
    assert.equal(ordinary.evidence.rawSold, 4);
    assert.ok(ordinary.curve.every((point) => point.price <= 560));
    const premium = await model.quoteAtPrices(facts, [700, 701, 800, 1000],
      { targetProbability: 0.25 });
    assert.deepEqual(premium.curve.map((point) => point.price), [700, 701, 800, 1000]);
    assert.equal(premium.evidence.soldCount, 5);
    assert.equal(premium.evidence.rawSold, 4);
    assert.ok(premium.curve.every((point) => point.meanProceeds >= point.price));
    for (let i = 1; i < premium.curve.length; i++)
      assert.ok(premium.curve[i].p <= premium.curve[i - 1].p);
  } finally { await model.close(); f.dispose(); }
});

test('premium probability responds to exact above-median outcomes', async () => {
  const f = fixture();
  const finals = [600, 650, 700, 1000, 1200];
  const strongStarts = [400, 450, 500, 800, 900];
  const weakStarts = [400, 450, 500, 500, 600];
  for (let i = 0; i < finals.length; i++) {
    f.add({ cardId: 'strong', rarity: 'R', price: strongStarts[i],
      sold: true, finalPrice: finals[i] });
    f.add({ cardId: 'weak', rarity: 'R', price: weakStarts[i],
      sold: true, finalPrice: finals[i] });
  }
  f.add({ cardId: 'strong', rarity: 'R', price: 1200 });
  f.add({ cardId: 'weak', rarity: 'R', price: 800 });
  f.add({ cardId: 'weak', rarity: 'R', price: 900 });
  const model = await createMarketModel({ dbPath: f.dbPath });
  try {
    const strong = await model.quoteAtPrices({ cardId: 'strong', rarity: 'R', shiny: false },
      [700, 800, 900, 1000]);
    const weak = await model.quoteAtPrices({ cardId: 'weak', rarity: 'R', shiny: false },
      [700, 800, 900, 1000]);
    assert.equal(strong.evidence.observedSaleMedian, weak.evidence.observedSaleMedian);
    assert.ok(strong.curve[2].p > weak.curve[2].p);
    assert.ok(strong.curve[3].p <= strong.curve[2].p);
    assert.ok(weak.curve[3].p <= weak.curve[2].p);
  } finally { await model.close(); f.dispose(); }
});

test('premium stats and chance use only history available at the chronological cutoff', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.add({ cardId: 'time-card', rarity: 'R',
    price: 500, sold: true, finalPrice: 600, endAt: 100 });
  for (let i = 0; i < 6; i++) f.add({ cardId: 'time-card', rarity: 'R',
    price: 4500, sold: true, finalPrice: 5000, endAt: 200 });
  const past = await createMarketModel({ dbPath: f.dbPath, maxEndAt: 150 });
  const full = await createMarketModel({ dbPath: f.dbPath });
  try {
    const facts = { cardId: 'time-card', rarity: 'R', shiny: false };
    const pastStats = await past.stats(facts);
    const fullStats = await full.stats(facts);
    assert.equal(pastStats.soldCount, 4);
    assert.equal(pastStats.median, 600);
    assert.equal(pastStats.p25, 600);
    assert.equal(fullStats.soldCount, 10);
    assert.equal(fullStats.median, 5000);
    const pastQuote = await past.quoteAtPrices(facts, [700]);
    const fullQuote = await full.quoteAtPrices(facts, [700]);
    assert.equal(pastQuote.evidence.observedSaleMedian, 600);
    assert.equal(pastQuote.evidence.rawSold, 4);
    assert.equal(fullQuote.evidence.rawSold, 10);
    assert.notEqual(pastQuote.curve[0].p, fullQuote.curve[0].p);
  } finally { await past.close(); await full.close(); f.dispose(); }
});

test('premium chronological holdout scores above-median asks with as-of medians', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.add({ cardId: 'rolling', rarity: 'R',
    price: 500, sold: true, finalPrice: 600, endAt: 100 });
  f.add({ cardId: 'rolling', rarity: 'R', price: 700,
    sold: true, finalPrice: 1000, endAt: 200 });
  f.add({ cardId: 'rolling', rarity: 'R', price: 700, endAt: 300 });
  for (let i = 0; i < 6; i++) f.add({ cardId: 'rolling', rarity: 'R',
    price: 4500, sold: true, finalPrice: 5000, endAt: 400 });
  f.add({ cardId: 'rolling', rarity: 'R', price: 700, endAt: 500 });
  const model = await createMarketModel({ dbPath: f.dbPath, maxEndAt: 150 });
  try {
    const holdout = await model.evaluatePremiumHoldout({ limit: 20,
      minSales: 4, medianThreshold: 500 });
    assert.equal(holdout.considered, 9);
    assert.equal(holdout.eligible, 9);
    assert.equal(holdout.n, 8);
    assert.ok(holdout.brier >= 0 && holdout.brier <= 1);
    assert.ok(holdout.logLoss >= 0);
    assert.equal(holdout.bins.reduce((sum, bin) => sum + bin.n, 0), 8);
    assert.equal(holdout.samples[0].priorMedian, 600);
    assert.equal(holdout.samples[0].priorSoldCount, 4);
    assert.equal(holdout.samples[1].priorMedian, 600);
    assert.equal(holdout.samples[1].priorSoldCount, 5);
    assert.ok(holdout.samples[1].predicted > holdout.samples[0].predicted);
    assert.ok(holdout.samples.slice(2).every((sample) =>
      sample.priorMedian === 600 && sample.priorSoldCount === 5));
  } finally { await model.close(); f.dispose(); }
});

test('premium cards with only repriced sales have no supported sale chance', async () => {
  const f = fixture();
  f.add({ cardId: 'ordinary', price: 1, sold: true, finalPrice: 2 });
  for (let i = 0; i < 4; i++) f.add({ cardId: 'repriced', rarity: 'R',
    price: 500, sold: true, finalPrice: 600 + i * 10, repriced: true });
  const model = await createMarketModel({ dbPath: f.dbPath });
  try {
    const facts = { cardId: 'repriced', rarity: 'R', shiny: false };
    assert.equal((await model.stats(facts)).soldCount, 4);
    const quote = await model.quoteAtPrices(facts, [616, 700, 770]);
    assert.equal(quote.evidence.rawSold, 0);
    assert.equal(quote.evidence.rawUnsold, 0);
    assert.ok(quote.curve.every((point) => point.p === 0 && point.meanProceeds >= point.price));
    assert.equal(quote.targetMet, false);
  } finally { await model.close(); f.dispose(); }
});

test('premium calibration fits only earlier above-median outcomes', async () => {
  const f = fixture();
  const hour = 60 * 60 * 1000;
  for (let i = 0; i < 1200; i++) {
    const cardId = `calibration-${i}`;
    for (let j = 0; j < 4; j++) f.add({ cardId, rarity: 'R',
      price: 500, sold: true, finalPrice: 600, endAt: 0 });
    f.add({ cardId, rarity: 'R', price: 700, endAt: 2 * hour });
  }
  const model = await createMarketModel({ dbPath: f.dbPath, maxEndAt: 13 * hour });
  try {
    const calibration = (await model.health()).premiumCalibration;
    assert.ok(calibration.n >= 30);
    assert.ok(calibration.shift > 0);
    const quote = await model.quoteAtPrices({ cardId: 'calibration-0', rarity: 'R', shiny: false }, [700]);
    assert.equal(quote.evidence.calibrationLogOdds, calibration.shift);
    assert.ok(quote.curve[0].p < 0.5);
  } finally { await model.close(); f.dispose(); }
});
