import test from 'node:test';
import assert from 'node:assert/strict';
import { createMoneyEngine, computeCutoff, isHumanVerificationResponse } from '../src/engine.js';
import { StateStore } from '../src/state.js';

const config = (dryRun) => ({
  dryRun, cycleMinutes: 3, maxActionsPerCycle: 25, actionGapMs: [0, 0],
  packs: { enabled: true, maxPerCycle: 5, gapMs: [0, 0], backoffMinutes: 10 },
  listing: { durationMinutes: 60, maxConcurrent: 5 },
  recycleValue: 1, listingFee: 0, targetProbability: 0.8,
  outcomePenalty: 0.25, modelLowerPenalty: 0.5, modelUpperBonus: 1.28,
  arrivalWindowHours: 48, minArrivalObservations: 12, maxMarketAgeHours: 24, modelRefreshMinutes: 30,
});

test('applying settings reserves the account until deal replanning finishes and releases it on failure', async () => {
  const engine = createMoneyEngine({ session: fakeSession([]), model: modelFor({}),
    config: config(true), liveRequested: true, store: new StateStore({ file: null, eventFile: null }) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  engine.setDealEngine({ updateConfig: () => gate });
  const change = engine.updateConfig(config(false));
  assert.equal(engine.getState().busy, true);
  await assert.rejects(engine.updateConfig(config(true)), /current account cycle/);
  release(); await change;
  assert.equal(engine.getState().busy, false);
  assert.equal(engine.getState().mode, 'live');
  engine.setDealEngine({ updateConfig: async () => { throw new Error('replan error'); } });
  await assert.rejects(engine.updateConfig(config(true)), /replan error/);
  assert.equal(engine.getState().busy, false);
  assert.equal(engine.getState().mode, 'live');
});

function card(id) {
  return { id: `copy-${id}`, card_id: id, is_shiny: false, card: {
    wikipedia_title: id, rarity: 'R', q_score: 50, pageviews: 100, atk: 5, def: 5,
  } };
}

function point(price, { p = 0.9, mu = 2, L = 1, U = 3 } = {}) {
  return { price, p, pLow: Math.max(0, p - 0.1), pHigh: Math.min(1, p + 0.1),
    meanProceeds: price, sigmaOutcome: 1, sigmaModel: 0.1, mu, L, U };
}

function modelFor(quotes) {
  return {
    health: async () => ({ ready: true, dataTimestamp: Date.now() }),
    quote: async (facts) => {
      const curve = quotes[facts.cardId];
      if (!curve) throw new Error(`no quote for ${facts.cardId}`);
      return { curve, chosen: curve.find((x) => x.mu > 0) ?? null,
        targetMet: curve.some((x) => x.p >= 0.8 && x.mu > 0),
        evidence: { rawSold: 10, rawUnsold: 2, effectiveN: 8, peerN: 100, cardLastSettledAt: 0 } };
    },
  };
}

function fakeSession(cards, { packsRemaining = 0 } = {}) {
const state = { cards: [...cards], active: [], history: [], balance: 100, calls: [], listingsPosted: [], packsRemaining };
  return {
    state,
    hasCookie: () => true, userId: () => 'money-account', username: () => 'money',
    rpc: async (name, _body) => {
      state.calls.push(`RPC ${name}`);
      return { status: 200, json: { packs_remaining: state.packsRemaining } };
    },
    request: async (method, url, options = {}) => {
      state.calls.push(`${method} ${url}`);
      if (method === 'GET' && url === '/api/wikibidous') return { status: 200, json: { balance: state.balance } };
      if (method === 'GET' && url.startsWith('/api/marketplace?page='))
        return { status: 200, json: { selling: [...state.active], history: [...state.history], maxConcurrentAuctions: 5 } };
      if (method === 'GET' && url.startsWith('/api/my-collection?')) {
        const page = Number(url.match(/page=(\d+)/)?.[1] ?? 0);
        return { status: 200, json: { collection: page === 0 ? [...state.cards] : [], total: state.cards.length, pendingTradeCardIds: [] } };
      }
      if (method === 'POST' && url === '/api/packs/open') {
        state.packsRemaining--;
        return { status: 200, json: { cards: [], owned_copies: [], packs_remaining: state.packsRemaining } };
      }
      if (method === 'POST' && url === '/api/marketplace') {
        state.listingsPosted.push(options.json);
        const owned = state.cards.find((c) => c.id === options.json?.card_id);
        if (!owned) return { status: 400, json: { error: 'not owned' } };
        const id = `auction-${state.calls.filter((x) => x === 'POST /api/marketplace').length}`;
        state.active.push({ id, card_id: owned.card_id, card: owned.card,
          snapshot_rarity: owned.card.rarity, base_amount: options.json.base_amount,
          end_at: new Date(Date.now() + options.json.duration_minutes * 60_000).toISOString() });
        return { status: 201, json: { auction_id: id } };
      }
      if (method === 'DELETE' && url.startsWith('/api/marketplace/')) {
        const id = url.split('/').at(-1);
        const active = state.active.find((a) => a.id === id);
        if (!active) return { status: 404, json: { error: 'not found' } };
        state.active = state.active.filter((a) => a.id !== id);
        state.history.push({ ...active, status: 'cancelled' });
        return { status: 200, json: { status: 'cancelled' } };
      }
      if (method === 'POST' && /\/discard$/.test(url)) {
        const id = url.split('/')[3];
        const before = state.cards.length;
        state.cards = state.cards.filter((c) => c.id !== id);
        if (before === state.cards.length) return { status: 400, json: { error: 'not owned' } };
        state.balance++;
        return { status: 200, json: { balance: state.balance } };
      }
      if (method === 'GET' && url.startsWith('/api/marketplace/')) {
        const id = url.split('/').at(-1);
        const auction = state.history.find((a) => a.id === id);
        return { status: auction ? 200 : 404, json: { auction, bids: auction?.bids ?? [] } };
      }
      throw new Error(`unexpected ${method} ${url}`);
    },
  };
}

test('external resale recovery frees sold purchases once and protects a live purchased listing', async () => {
  const session = fakeSession([]);
  const store = new StateStore({ file: null, eventFile: null });
  const purchasedAt = Date.now() - 7200000;
  for (const id of ['sold', 'active', 'ambiguous']) {
    store.data.purchases[`copy-${id}`] = { userCardId: `copy-${id}`, auctionId: `buy-${id}`,
      cardId: id, title: id, rarity: 'R', shiny: false, purchasePrice: 13, accruedFees: 2,
      status: 'inventory', purchasedAt };
    store.data.bids[`buy-${id}`] = { ownedBeforeIds: id === 'ambiguous' ? ['old-copy'] : [] };
  }
  const auction = (id, status) => ({ id: `manual-${id}`, card_id: id, card: card(id).card,
    seller_id: 'money-account', snapshot_rarity: 'R', is_shiny: false, status,
    created_at: new Date(purchasedAt + 10000).toISOString(),
    end_at: new Date(Date.now() + (status === 'active' ? 3600000 : -1000)).toISOString(),
    base_amount: 25, final_price: status === 'settled_sold' ? 25 : null });
  const sold = auction('sold', 'settled_sold');
  session.state.active.push(auction('active', 'active'));
  const model = { ...modelFor({}), purchaseAuctions: async (sellerId) => {
    assert.equal(sellerId, 'money-account');
    return [sold, auction('ambiguous', 'settled_sold')];
  } };
  const cfg = { ...config(true), listingFee: 1, packs: { enabled: false }, premium: { listingDurationExperiment: true } };
  const engine = createMoneyEngine({ session, model, config: cfg, store });
  await engine.runNow();
  assert.equal(store.data.purchases['copy-sold'].status, 'sold');
  assert.equal(store.data.purchases['copy-sold'].saleAuctionId, 'manual-sold');
  assert.equal(store.data.purchases['copy-sold'].realizedProfit, 9);
  assert.equal(store.data.purchases['copy-active'].status, 'inventory');
  assert.equal(store.data.listings['manual-active'].kind, 'purchase');
  assert.equal(store.data.listings['manual-active'].durationExperiment, null);
  assert.equal(store.data.purchases['copy-ambiguous'].status, 'inventory');
  assert.equal(store.data.stats.salesRevenue, 25);
  assert.equal(store.data.stats.listingFees, 2);
  assert.equal(engine.getState().listingDurationComparison.groups.all[0].placed, 0);
  await engine.runNow();
  assert.equal(store.data.stats.salesRevenue, 25);
  assert.equal(store.data.stats.listingFees, 2);
  assert.equal(store.events.filter(e => e.type === 'purchase-listing-recovered').length, 2);
  assert.equal(session.state.calls.some(c => c.startsWith('POST') || c.startsWith('DELETE')), false);
});

test('verification status keeps an unresolved pack check when another API has a transient server error', () => {
  assert.equal(isHumanVerificationResponse({ status: 525,
    text: 'Cloudflare 525 SSL handshake failed' }), false);
  assert.equal(isHumanVerificationResponse({ status: 403,
    json: { error: 'Vérification anti-bot requise.' } }), true);
  const session = fakeSession([]);
  const store = new StateStore({ file: null, eventFile: null });
  const engine = createMoneyEngine({ session, model: modelFor({}), config: config(true), store });
  session.onResponse({ method: 'POST', path: '/api/packs/open', status: 403, service: 'site',
    json: { error: 'Vérification anti-bot requise.' } });
  session.onResponse({ method: 'GET', path: '/api/my-collection', status: 525, service: 'site',
    text: 'Cloudflare 525 SSL handshake failed' });
  session.onResponse({ method: 'GET', path: '/api/my-collection', status: 200, service: 'site', json: {} });
  assert.equal(engine.getState().humanVerification.path, '/api/packs/open');
  assert.equal(engine.getState().humanVerifications.length, 1);
  session.onResponse({ method: 'POST', path: '/api/marketplace', status: 403, service: 'site',
    json: { error: 'human_verification_required' } });
  assert.equal(engine.getState().humanVerifications.length, 2);
  session.onResponse({ method: 'POST', path: '/api/marketplace', status: 201, service: 'site',
    json: { auction_id: 'listing' } });
  assert.equal(engine.getState().humanVerifications.length, 1);
  assert.equal(engine.getState().humanVerification.path, '/api/packs/open');
  delete store.data.humanVerifications;
  store.data.humanVerification = null;
  const restarted = createMoneyEngine({ session, model: modelFor({}), config: config(true), store });
  assert.equal(restarted.getState().humanVerification.path, '/api/packs/open');
  assert.equal(restarted.getState().packs.blocked.kind, 'human');
});

test('owner verification retry acknowledges old notices, recovers bids, and lets a new challenge return', () => {
  const session = fakeSession([]);
  const store = new StateStore({ file: null, eventFile: null });
  const engine = createMoneyEngine({ session, model: modelFor({}), config: config(false),
    liveRequested: true, store });
  const path = '/api/marketplace/blocked-auction/bid';
  session.onResponse({ method: 'POST', path, status: 403, json: { error: 'Vérification anti-bot requise.' } });
  let recovered;
  engine.setDealEngine({ retryVerification: (ids) => { recovered = ids; return { recoveredAuctions: 1 }; } });
  engine.pause();
  assert.equal(engine.retryVerification().ok, false);
  engine.resume();
  assert.equal(engine.retryVerification().recoveredAuctions, 1);
  assert.deepEqual(recovered, ['blocked-auction']);
  assert.equal(engine.getState().humanVerification, null);
  const restarted = createMoneyEngine({ session, model: modelFor({}), config: config(false), liveRequested: true, store });
  assert.equal(restarted.getState().humanVerification, null);
  session.onResponse({ method: 'POST', path, status: 403, json: { error: 'Vérification anti-bot requise.' } });
  assert.equal(restarted.getState().humanVerification.path, path);
});

const engineFor = (session, model, dryRun = false, more = {}) => createMoneyEngine({
  session, model, config: config(dryRun), liveRequested: true,
  store: new StateStore({ file: null, eventFile: null }), wait: async () => {}, ...more,
});

test('live duration experiment sends both arms and saves their outcome attribution across restart', async () => {
  const session = fakeSession([card('short'), card('long')]);
  const store = new StateStore({ file: null, eventFile: null });
  const rolls = [0.1, 0.9];
  const settings = { ...config(false), premium: { enabled: false, listingDurationExperiment: true } };
  const model = modelFor({ short: [point(100, { L: 4 })], long: [point(100, { L: 4 })] });
  const engine = engineFor(session, model, false, { store, config: settings, durationRandom: () => rolls.shift() });
  assert.equal((await engine.runNow()).ok, true);
  assert.deepEqual(session.state.listingsPosted.map((row) => row.duration_minutes), [10, 60]);
  const listings = Object.values(store.data.listings);
  assert.deepEqual(listings.map((row) => row.endAt - row.createdAt), [600000, 3600000]);
  assert.ok(listings.every((row) => row.forecast.durationMinutes === 60));
  assert.deepEqual(store.events.filter((row) => row.type === 'listed').map((row) => row.durationMinutes), [10, 60]);
  const first = session.state.active.shift();
  session.state.cards = session.state.cards.filter((row) => row.card_id !== first.card_id);
  session.state.history.push({ ...first, status: 'settled_sold', final_price: 110, bids: [{ amount: 110 }] });
  const restored = new StateStore({ file: null, eventFile: null });
  restored.data = JSON.parse(JSON.stringify(store.data));
  const restarted = engineFor(session, model, false, { store: restored, config: settings });
  assert.equal((await restarted.runNow()).ok, true);
  assert.equal(restarted.getState().listingDurationComparison.groups.pack[0].sold, 1);
  assert.equal(restarted.getState().listingDurationComparison.groups.pack[1].active, 1);
  assert.equal(restored.events.find((row) => row.type === 'sold').durationMinutes, 10);
  assert.equal(restored.events.find((row) => row.type === 'auction-result').durationMinutes, 10);
});

test('duration experiment cannot turn dry-run proposals into recorded live observations', async () => {
  const engine = engineFor(fakeSession([card('dry')]), modelFor({ dry: [point(10, { L: 4 })] }), true,
    { config: { ...config(true), premium: { enabled: false, listingDurationExperiment: true } },
      durationRandom: () => { throw new Error('dry-run must not assign a live cohort'); } });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(engine.getState().listingDurationComparison.groups.all[0].placed, 0);
});

test('hybrid acquisition plan survives a failed auction and returned copy ID, then holds after its attempt budget', async () => {
  const session = fakeSession([card('hybrid-resale')]);
  const store = new StateStore({ file: null, eventFile: null });
  store.data.purchases['copy-hybrid-resale'] = { userCardId: 'copy-hybrid-resale',
    cardId: 'hybrid-resale', rarity: 'R', shiny: false, purchasePrice: 60,
    minProfit: 15, minRoi: 0.25, accruedFees: 0, status: 'inventory', purchasedAt: Date.now() - 60_000,
    resalePlan: { ask: 100, floor: 75, stepDownPct: 0.08, attemptLimit: 2, durationMinutes: 60 } };
  const quotes = [];
  const model = modelFor({});
  model.dealQuote = async (facts, options) => {
    quotes.push({ facts, options });
    assert.equal(options.buy.minBuyers, 1, 'new buying filters do not stall a recorded owned exit');
    return { curve: options.askPrices.map((price) => ({ ...point(price), horizonP: 0.85 })),
      evidence: { rawSold: 10, rawUnsold: options.ownOutcomes.filter((row) => row.status === 'settled_unsold').length,
        effectiveN: 8 }, dataTimestamp: Date.now() };
  };
  const engine = engineFor(session, model, false, { store, config: { ...config(false),
    buy: { hybridEnabled: true, minBuyers: 4, liquidMinProfit: 75 },
    premium: { enabled: true, listingDurationExperiment: true } }, durationRandom: () => 0.1 });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active[0].base_amount, 100);
  assert.equal(session.state.listingsPosted[0].duration_minutes, 10);
  assert.equal(store.data.purchases['copy-hybrid-resale'].resalePlan.durationMinutes, 60);
  const first = session.state.active.pop();
  session.state.history.push({ ...first, status: 'settled_unsold', end_at: new Date(Date.now() - 1).toISOString() });
  session.state.cards = [{ ...card('hybrid-resale'), id: 'returned-copy' }];
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active[0].base_amount, 92);
  assert.equal(session.state.listingsPosted[1].duration_minutes, 10);
  assert.equal(engine.getState().listingDurationComparison.groups.purchase[0].unsold, 1);
  assert.equal(store.data.purchases['copy-hybrid-resale'], undefined);
  assert.equal(store.data.purchases['returned-copy'].purchasePrice, 60);
  assert.equal(store.data.listings[first.id].userCardId, 'returned-copy');
  assert.ok(quotes.at(-1).options.ownOutcomes.some((row) => row.auctionId === first.id && row.status === 'settled_unsold'));
  const second = session.state.active.pop();
  session.state.history.push({ ...second, status: 'settled_unsold', end_at: new Date(Date.now() - 1).toISOString() });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active.length, 0);
  assert.match(engine.getState().decisions[0].reason, /attempt budget/);
  assert.equal(engine.getState().stats.recycled, 0);
});

test('hybrid ambiguity holds returned purchased variants instead of recycling an unassigned copy', async () => {
  const session = fakeSession([{ ...card('ambiguous'), id: 'new-1' }, { ...card('ambiguous'), id: 'new-2' }]);
  const store = new StateStore({ file: null, eventFile: null });
  store.data.purchases.old = { userCardId: 'old', cardId: 'ambiguous', rarity: 'R', shiny: false,
    purchasePrice: 60, minProfit: 15, status: 'inventory' };
  store.data.listings.failed = { auctionId: 'failed', userCardId: 'old', cardId: 'ambiguous', rarity: 'R',
    shiny: false, status: 'settled_unsold', price: 100 };
  const engine = engineFor(session, modelFor({}), false, { store,
    config: { ...config(false), buy: { hybridEnabled: true } } });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active.length, 0);
  assert.equal(engine.getState().decisions.length, 2);
  assert.ok(engine.getState().decisions.every((row) => /unambiguous attribution/.test(row.reason)));
  assert.equal(engine.getState().stats.recycled, 0);
  assert.equal(store.data.purchases.old.purchasePrice, 60);
});

test('dry-run evaluates inventory without changing the account', async () => {
  const session = fakeSession([card('sell'), card('junk')], { packsRemaining: 2 });
  const model = modelFor({ sell: [point(10, { L: 4, U: 6 })], junk: [point(1, { mu: -1, L: -2, U: -0.1 })] });
  const engine = engineFor(session, model, true);
  const result = await engine.runNow();
  assert.equal(result.ok, true);
  assert.equal(engine.getState().mode, 'dry-run');
  assert.deepEqual(engine.getState().decisions.map((r) => r.action).sort(), ['list', 'recycle']);
  assert.equal(session.state.calls.some((x) => x.startsWith('POST ') || x.startsWith('RPC ')), false);
});

test('anti-bot pack block recognizes accented French text and manual retry clears its wait', async () => {
  const session = fakeSession([], { packsRemaining: 1 });
  const request = session.request;
  let blockedOnce = false;
  session.request = async (method, url, options) => {
    if (method === 'POST' && url === '/api/packs/open' && !blockedOnce) {
      blockedOnce = true;
      return { status: 403, json: { error: 'Vérification anti-bot requise pour continuer à ouvrir des paquets.' } };
    }
    return request(method, url, options);
  };
  const engine = engineFor(session, modelFor({}));
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(engine.getState().packs.blocked.kind, 'human');
  assert.equal(engine.getState().stats.opened, 0);
  const retry = engine.retryPacks();
  assert.equal(retry.ok, true);
  assert.equal((await retry.completion).ok, true);
  assert.equal(engine.getState().stats.opened, 1);
  assert.equal(engine.getState().packs.blocked, null);
});

test('retry can be queued while an inventory cycle is busy', async () => {
  const session = fakeSession([], { packsRemaining: 1 });
  const request = session.request;
  let blockFirst = true;
  let holdCollection = false;
  let releaseCollection;
  const collectionGate = new Promise((resolve) => { releaseCollection = resolve; });
  session.request = async (method, url, options) => {
    if (method === 'POST' && url === '/api/packs/open' && blockFirst) {
      blockFirst = false;
      return { status: 403, json: { error: 'Vérification anti-bot requise.' } };
    }
    if (method === 'GET' && url.startsWith('/api/my-collection?') && holdCollection) {
      holdCollection = false;
      await collectionGate;
    }
    return request(method, url, options);
  };
  const engine = engineFor(session, modelFor({}));
  await engine.runNow();
  holdCollection = true;
  const inFlight = engine.runNow();
  const queued = engine.retryPacks();
  assert.equal(queued.ok, true);
  assert.equal(queued.queued, true);
  assert.equal(engine.getState().packs.retryQueued, true);
  releaseCollection();
  await inFlight;
  for (let i = 0; i < 20 && engine.getState().stats.opened === 0; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.getState().stats.opened, 1);
  assert.equal(engine.getState().packs.retryQueued, false);
});

test('live cycle preserves four routine slots, uses one trial slot, and recycles only negative upside', async () => {
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'trial', 'junk'];
  const session = fakeSession(ids.map(card));
  const quotes = Object.fromEntries(ids.slice(0, 5).map((id, i) => [id, [point(10 + i, { L: 10 - i, U: 11 - i })]]));
  quotes.trial = [point(20, { p: 0.5, mu: -0.3, L: -1, U: 20 })];
  quotes.junk = [point(1, { mu: -1, L: -2, U: -0.1 })];
  const engine = engineFor(session, modelFor(quotes));
  const result = await engine.runNow();
  assert.equal(result.ok, true);
  assert.equal(session.state.active.length, 5);
  assert.equal(engine.getState().slots.trialActive, 1);
  assert.equal(session.state.active.some((a) => a.card_id === 'r5'), false);
  assert.equal(session.state.cards.some((a) => a.card_id === 'junk'), false);
  assert.equal(engine.getState().stats.recycled, 1);
});

test('duplicate owned copies take only one slot so another card can list', async () => {
  const duplicate = { ...card('repeat'), id: 'copy-repeat-2' };
  const session = fakeSession([card('repeat'), duplicate, card('other')]);
  const model = modelFor({
    repeat: [point(10, { L: 5, U: 6 })],
    other: [point(8, { L: 3, U: 4 })],
  });
  const engine = engineFor(session, model);
  assert.equal((await engine.runNow()).ok, true);
  assert.deepEqual(session.state.active.map((a) => a.card_id).sort(), ['other', 'repeat']);
});

test('a failed recheck backfills its slot with the next card', async () => {
  const session = fakeSession([card('vanishing'), card('backup')]);
  const original = session.request;
  let collectionReads = 0;
  session.request = async (method, url, options) => {
    if (method === 'GET' && url.startsWith('/api/my-collection?') && ++collectionReads === 2)
      session.state.cards = [card('backup')];
    return original(method, url, options);
  };
  const engine = engineFor(session, modelFor({
    vanishing: [point(10, { L: 5, U: 6 })],
    backup: [point(8, { L: 3, U: 4 })],
  }));
  assert.equal((await engine.runNow()).ok, true);
  assert.deepEqual(session.state.active.map((a) => a.card_id), ['backup']);
});

test('after an unsold listing, choose a lower price before repeating it', async () => {
  const session = fakeSession([card('repeat')]);
  const high = point(10, { L: 4, U: 6 });
  const low = point(8, { L: 2, U: 4 });
  const model = modelFor({ repeat: [high, low] });
  const store = new StateStore({ file: null, eventFile: null });
  const first = engineFor(session, model, false, { store });
  assert.equal((await first.runNow()).ok, true);
  const old = session.state.active.pop();
  session.state.history.push({ ...old, status: 'settled_unsold', end_at: new Date(Date.now() - 1000).toISOString() });
  const engine = engineFor(session, model, false, { store }); // a fresh process reconciles its recorded auction
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active[0].base_amount, 8);
  assert.equal(engine.getState().stats.unsold, 1);
});

test('cutoff rises only after observed arrivals exceed measured slot throughput', () => {
  const now = Date.now();
  const arrivals = Array.from({ length: 30 }, (_, i) => ({ at: now - (4 - 4 * i / 30) * 3_600_000, score: i + 1 }));
  assert.equal(computeCutoff(arrivals.slice(0, 3), { now }).value, 0);
  const open = computeCutoff(arrivals, { now });
  assert.ok(open.value > 0);
  const slots = Array.from({ length: 25 }, (_, i) => ({ at: now - (4 - 4 * i / 25) * 3_600_000, active: 5 }));
  const completions = Array.from({ length: 5 }, (_, i) => ({ settledAt: now - (3.5 - i * 0.7) * 3_600_000 }));
  const constrained = computeCutoff(arrivals, { now, slotSamples: slots, completions });
  assert.ok(constrained.capacityPerHour < open.capacityPerHour);
  assert.ok(constrained.value >= open.value);
});

test('arrival value follows the preferred 80% listing price', async () => {
  const session = fakeSession([card('target')]);
  const store = new StateStore({ file: null, eventFile: null });
  store.data.baselineSeen = true;
  const highChance = point(8, { p: 0.85, L: 2, U: 3 });
  const lowChance = point(20, { p: 0.5, L: 30, U: 40 });
  const engine = engineFor(session, modelFor({ target: [highChance, lowChance] }), true, { store });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(store.data.arrivals[0].score, 2);
});

test('a positive cautious fallback lists when the 80% price fails the slot cutoff', async () => {
  const session = fakeSession([card('fallback')]);
  const highChance = point(2, { p: 0.85, mu: 1, L: -0.1, U: 2 });
  const lowerChance = point(4, { p: 0.72, mu: 3, L: 1.5, U: 4 });
  const engine = engineFor(session, modelFor({ fallback: [highChance, lowerChance] }));
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active[0].base_amount, 4);
  assert.equal(engine.getState().decisions[0].targetMet, false);
});

test('zero exact-card sales recycle non-UR/L copies while UR and L fill spare slots', async () => {
  const owned = ['common', 'special', 'premium', 'ultra', 'legend'].map(card);
  for (const [i, rarity] of ['C', 'SR', 'PC', 'UR', 'L'].entries()) owned[i].card.rarity = rarity;
  const session = fakeSession(owned);
  const curves = Object.fromEntries(owned.map((e, i) => [e.card_id, [point(10 + i, { L: 4, U: 5 + i })]]));
  const model = modelFor(curves);
  const originalQuote = model.quote;
  model.quote = async (facts) => {
    const quote = await originalQuote(facts);
    quote.evidence.rawSold = 0;
    quote.evidence.rawUnsold = 0;
    quote.evidence.effectiveN = 0;
    quote.evidence.independentAuctionGroups = 0;
    return quote;
  };
  const engine = engineFor(session, model);
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(engine.getState().stats.recycled, 3);
  assert.deepEqual(session.state.cards.map((c) => c.card_id).sort(), ['legend', 'ultra']);
  assert.equal(session.state.active.length, 2);
  assert.equal(engine.getState().slots.trialActive, 2);
});

test('queued exploratory cards fill every spare slot', async () => {
  const ids = ['one', 'two', 'three', 'four', 'five'];
  const session = fakeSession(ids.map(card));
  const model = modelFor(Object.fromEntries(ids.map((id, i) => [id, [point(5 + i, { L: -1, U: 10 - i })]])));
  const originalQuote = model.quote;
  model.quote = async (facts) => {
    const quote = await originalQuote(facts);
    quote.evidence.independentAuctionGroups = 1;
    return quote;
  };
  const engine = engineFor(session, model);
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(engine.getState().slots.active, 5);
  assert.equal(engine.getState().slots.trialActive, 5);
});

test('duplicate account gate runs before site requests and pack opening', async () => {
  const session = fakeSession([card('sell')], { packsRemaining: 2 });
  const engine = engineFor(session, modelFor({ sell: [point(10)] }), false, { accountAllowed: () => false });
  const result = await engine.runNow();
  assert.equal(result.ok, false);
  assert.equal(session.state.calls.length, 0);
  assert.match(engine.getState().problem, /another bot account/);
});

test('full slots replace an unbid weak listing only for a much stronger queued card', async () => {
  const ids = ['weak', 'steady1', 'steady2', 'steady3', 'steady4', 'strong'];
  const session = fakeSession(ids.slice(0, 5).map(card));
  const quotes = Object.fromEntries(ids.map((id) => [id, [point(10, { L: id === 'weak' ? 1 : id === 'strong' ? 40 : 20, U: 45 })]]));
  const engine = engineFor(session, modelFor(quotes));
  assert.equal((await engine.runNow()).ok, true);
  session.state.cards.push(card('strong'));
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.calls.filter((c) => c.startsWith('DELETE /api/marketplace/')).length, 1);
  assert.equal(session.state.active.some((a) => a.card_id === 'weak'), false);
  assert.equal(session.state.active.some((a) => a.card_id === 'strong'), true);
  assert.equal(session.state.active.length, 5);
});

test('manual removal works while paused and refuses listings with bids', async () => {
  const session = fakeSession([card('manual')]);
  const engine = engineFor(session, modelFor({ manual: [point(10, { L: 5 })] }));
  assert.equal((await engine.runNow()).ok, true);
  engine.pause();
  session.state.active[0].current_bid = 12;
  assert.equal((await engine.removeListing(session.state.active[0].id)).ok, false);
  session.state.active[0].current_bid = null;
  const removed = await engine.removeListing(session.state.active[0].id);
  assert.equal(removed.ok, true);
  assert.equal(session.state.active.length, 0);
  assert.equal(engine.getState().paused, true);
  const result = engine.getState().events.find((event) => event.type === 'auction-result');
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.bids, []);
});

test('automatic replacement leaves bid listings and modest improvements alone', async () => {
  const ids = ['one', 'two', 'three', 'four', 'five', 'better'];
  const session = fakeSession(ids.slice(0, 5).map(card));
  const quotes = Object.fromEntries(ids.map((id) => [id, [point(10, { L: id === 'better' ? 14 : 10, U: 20 })]]));
  const engine = engineFor(session, modelFor(quotes));
  assert.equal((await engine.runNow()).ok, true);
  session.state.cards.push(card('better'));
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.calls.some((c) => c.startsWith('DELETE ')), false);
  quotes.better[0].L = 50;
  for (const auction of session.state.active) auction.current_bid = 12;
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.calls.some((c) => c.startsWith('DELETE ')), false);
});

test('a much better queued card replaces an unbid listing even with exploratory slots active', async () => {
  const ids = ['weak', 't1', 't2', 't3', 't4', 'strong'];
  const session = fakeSession(ids.slice(0, 5).map(card));
  const model = modelFor(Object.fromEntries(ids.map((id) => [id, [point(10, {
    L: id === 'strong' ? 40 : id === 'weak' ? 1 : 2,
    U: id === 'strong' ? 50 : 10,
  })]])));
  const originalQuote = model.quote;
  model.quote = async (facts) => {
    const quote = await originalQuote(facts);
    quote.evidence.independentAuctionGroups = facts.cardId.startsWith('t') ? 1 : 3;
    return quote;
  };
  const engine = engineFor(session, model);
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(engine.getState().slots.active, 5);
  assert.equal(engine.getState().slots.trialActive, 4);
  session.state.cards.push(card('strong'));
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active.some((a) => a.card_id === 'weak'), false);
  assert.equal(session.state.active.some((a) => a.card_id === 'strong'), true);
  assert.equal(engine.getState().slots.active, 5);
});

test('replacement lists its strong challenger before a weaker queued routine card', async () => {
  const ids = ['weak', 'a', 'b', 'c', 'd', 'strong-trial', 'ordinary'];
  const session = fakeSession(ids.slice(0, 5).map(card));
  const model = modelFor(Object.fromEntries(ids.map((id) => [id, [point(10, {
    L: id === 'strong-trial' ? 40 : id === 'weak' ? 1 : id === 'ordinary' ? 5 : 30,
    U: id === 'strong-trial' ? 50 : 35,
  })]])));
  const originalQuote = model.quote;
  model.quote = async (facts) => {
    const quote = await originalQuote(facts);
    quote.evidence.independentAuctionGroups = facts.cardId === 'strong-trial' ? 1 : 3;
    return quote;
  };
  const engine = engineFor(session, model);
  assert.equal((await engine.runNow()).ok, true);
  session.state.cards.push(card('strong-trial'), card('ordinary'));
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active.some((a) => a.card_id === 'weak'), false);
  assert.equal(session.state.active.some((a) => a.card_id === 'strong-trial'), true);
  assert.equal(session.state.active.some((a) => a.card_id === 'ordinary'), false);
});

test('one positive cautious trial can replace a weak full slot', async () => {
  const ids = ['weak', 'two', 'three', 'four', 'five', 'trial'];
  const session = fakeSession(ids.slice(0, 5).map(card));
  const curves = Object.fromEntries(ids.map((id) => [id, [point(10, {
    L: id === 'weak' ? 1 : id === 'trial' ? 20 : 25, U: id === 'trial' ? 40 : 30,
  })]]));
  const model = modelFor(curves);
  const quote = model.quote;
  model.quote = async (facts) => {
    const result = await quote(facts);
    if (facts.cardId === 'trial') result.evidence.independentAuctionGroups = 1;
    return result;
  };
  const engine = engineFor(session, model);
  assert.equal((await engine.runNow()).ok, true);
  session.state.cards.push(card('trial'));
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active.some((a) => a.card_id === 'weak'), false);
  assert.equal(session.state.active.some((a) => a.card_id === 'trial'), true);
  assert.equal(engine.getState().slots.trialActive, 1);
});

test('two independent auctions with a positive cautious score can fill a spare routine slot', async () => {
  const session = fakeSession([card('two'), card('one')]);
  const model = modelFor({
    two: [point(8, { L: 2, U: 4 })],
    one: [point(6, { L: 1, U: 3 })],
  });
  const originalQuote = model.quote;
  model.quote = async (facts) => {
    const quote = await originalQuote(facts);
    quote.evidence.independentAuctionGroups = facts.cardId === 'two' ? 2 : 1;
    return quote;
  };
  const engine = engineFor(session, model);
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active.length, 2);
  assert.equal(engine.getState().slots.trialActive, 1);
  assert.equal(engine.getState().activeListings.find((a) => a.cardId === 'two').kind, 'routine');
  assert.equal(engine.getState().activeListings.find((a) => a.cardId === 'one').kind, 'trial');
});

test('no-sale non-UR card with no supported price curve is recycled', async () => {
  const session = fakeSession([card('unknown')]);
  const model = modelFor({ unknown: [point(10)] });
  model.quote = async () => ({ curve: [], chosen: null, evidence: { rawSold: 0, effectiveN: 0 } });
  const engine = engineFor(session, model);
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(engine.getState().stats.recycled, 1);
});

test('one card-specific discard failure does not block recycling the next card', async () => {
  const session = fakeSession([card('bad'), card('good')]);
  const request = session.request;
  session.request = async (method, url, options) => {
    if (method === 'POST' && url === '/api/user-cards/copy-bad/discard')
      return { status: 500, json: { error: 'Impossible de défausser la carte' } };
    return request(method, url, options);
  };
  const junk = point(1, { mu: -1, L: -2, U: -0.1 });
  const engine = engineFor(session, modelFor({ bad: [junk], good: [junk] }));
  assert.equal((await engine.runNow()).ok, true);
  assert.deepEqual(session.state.cards.map((c) => c.card_id), ['bad']);
  assert.equal(engine.getState().stats.recycled, 1);
  assert.match(engine.getState().lastError, /Impossible de défausser/);
  assert.equal(engine.getState().events.at(-2).type, 'recycle-failed');
});

test('a temporary discard failure retries the same card after a fresh ownership check', async () => {
  const session = fakeSession([card('retry')]);
  const request = session.request;
  let discards = 0;
  session.request = async (method, url, options) => {
    if (method === 'POST' && url === '/api/user-cards/copy-retry/discard' && ++discards === 1)
      return { status: 500, json: { error: 'temporary error' } };
    return request(method, url, options);
  };
  const junk = point(1, { mu: -1, L: -2, U: -0.1 });
  const engine = engineFor(session, modelFor({ retry: [junk] }));
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(discards, 2);
  assert.equal(session.state.cards.length, 0);
  assert.equal(engine.getState().stats.recycled, 1);
  assert.equal(engine.getState().lastError, null);
  assert.deepEqual(engine.getState().events.slice(-2).map((event) => event.type), ['recycle-retry', 'recycled']);
  assert.ok(session.state.calls.filter((call) => call.startsWith('GET /api/my-collection?')).length >= 3);
});

test('model health failure prevents packs and all other account actions', async () => {
  const session = fakeSession([card('sell')], { packsRemaining: 2 });
  const model = modelFor({ sell: [point(10)] });
  model.health = async () => { throw new Error('database unavailable'); };
  const engine = engineFor(session, model);
  const result = await engine.runNow();
  assert.equal(result.ok, false);
  assert.equal(session.state.calls.length, 0);
  assert.match(engine.getState().problem, /database unavailable/);
});

test('a transient collection HTTP 500 is retried and a free slot is filled', async () => {
  const session = fakeSession([card('sell')]);
  const request = session.request;
  let reads = 0;
  session.request = async (method, url, options) => {
    if (method === 'GET' && url.startsWith('/api/my-collection?') && ++reads === 1)
      return { status: 500, text: '<!DOCTYPE html>' };
    return request(method, url, options);
  };
  const engine = engineFor(session, modelFor({ sell: [point(10, { L: 3, U: 4 })] }));
  assert.equal((await engine.runNow()).ok, true);
  assert.ok(reads >= 2);
  assert.equal(session.state.active.length, 1);
  assert.equal(engine.getState().slots.free, 4);
});

test('a persistent collection HTTP 500 leaves owned cards untouched', async () => {
  const session = fakeSession([card('sell')]);
  const request = session.request;
  let reads = 0;
  session.request = async (method, url, options) => {
    if (method === 'GET' && url.startsWith('/api/my-collection?')) {
      reads++;
      return { status: 500, text: '<!DOCTYPE html>' };
    }
    return request(method, url, options);
  };
  const engine = engineFor(session, modelFor({ sell: [point(10, { L: 3, U: 4 })] }));
  assert.equal((await engine.runNow()).ok, false);
  assert.equal(reads, 3);
  assert.equal(session.state.active.length, 0);
  assert.equal(session.state.cards.length, 1);
  assert.equal(session.state.calls.some((x) => x.startsWith('POST /api/marketplace') || x.includes('/discard')), false);
  assert.match(engine.getState().problem, /collection: HTTP 500/);
});

test('one failed inventory quote blocks live listing and recycling for the entire cycle', async () => {
  const session = fakeSession([card('sell'), card('unknown')]);
  const engine = engineFor(session, modelFor({ sell: [point(10, { L: 3, U: 4 })] }));
  const result = await engine.runNow();
  assert.equal(result.ok, true);
  assert.equal(session.state.calls.some((x) => x.startsWith('POST /api/marketplace') || x.includes('/discard')), false);
  assert.match(engine.getState().problem, /inventory quotes failed/);
});

test('a copy removed after the inventory scan is not listed', async () => {
  const session = fakeSession([card('vanishing')]);
  const original = session.request;
  let collectionReads = 0;
  session.request = async (method, url, options) => {
    if (method === 'GET' && url.startsWith('/api/my-collection?') && ++collectionReads === 2)
      session.state.cards = [];
    return original(method, url, options);
  };
  const engine = engineFor(session, modelFor({ vanishing: [point(10, { L: 3, U: 4 })] }));
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.calls.includes('POST /api/marketplace'), false);
});

test('sale payout discrepancy is visible after reconciliation', async () => {
  const session = fakeSession([card('fee')]);
  const engine = engineFor(session, modelFor({ fee: [point(10, { L: 3, U: 4 })] }));
  assert.equal((await engine.runNow()).ok, true);
  const old = session.state.active.pop();
  session.state.cards = [];
  session.state.balance += 9; // a one-coin fee or an outside balance change
  session.state.history.push({ ...old, status: 'settled_sold', final_price: 10,
    end_at: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(engine.getState().accounting.unexplainedDelta, -1);
  assert.equal(engine.getState().stats.salesRevenue, 10);
});

test('completed own auction saves every bid and the listing forecast once', async () => {
  const session = fakeSession([card('bid-card')]);
  const store = new StateStore({ file: null, eventFile: null });
  const engine = engineFor(session, modelFor({ 'bid-card': [point(10, { L: 3, U: 4 })] }), false, { store });
  assert.equal((await engine.runNow()).ok, true);
  const old = session.state.active.pop();
  session.state.cards = [];
  session.state.balance += 14;
  session.state.history.push({ ...old, status: 'settled_sold', final_price: 14,
    end_at: new Date(Date.now() - 1000).toISOString(), bids: [
      { id: 'bid-1', amount: 10, placed_at: '2026-10-02T10:00:00Z', bidder_id: 'buyer-a' },
      { id: 'bid-2', amount: 14, placed_at: '2026-10-02T10:01:00Z', bidder_id: 'buyer-b' },
    ] });
  assert.equal((await engine.runNow()).ok, true);
  const recorded = engine.getState().events.filter((event) => event.type === 'auction-result');
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].bids.map((bid) => bid.amount), [10, 14]);
  assert.equal(recorded[0].forecast.p, 0.9);
  assert.equal(store.data.listings[old.id].bidHistoryCaptured, true);
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(engine.getState().events.filter((event) => event.type === 'auction-result').length, 1);
});

test('active bid changes are saved once per observed value', async () => {
  const session = fakeSession([card('bid-watch')]);
  const engine = engineFor(session, modelFor({ 'bid-watch': [point(10)] }));
  assert.equal((await engine.runNow()).ok, true);
  session.state.active[0].current_bid = 12;
  session.state.active[0].bid_count = 2;
  assert.equal((await engine.runNow()).ok, true);
  assert.equal((await engine.runNow()).ok, true);
  const observed = engine.getState().events.filter((event) => event.type === 'bid-observed');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].currentBid, 12);
  assert.equal(observed[0].bidCount, 2);
});

test('premium account starts above median and steps down without crossing a bought copy profit floor', async () => {
  const session = fakeSession([card('premium')]);
  const store = new StateStore({ file: null, eventFile: null });
  store.data.purchases = { 'copy-premium': { cardId: 'premium', purchasePrice: 400,
    accruedFees: 0, status: 'owned' } };
  const model = modelFor({ premium: [point(400)] });
  model.stats = async () => ({ soldCount: 4, median: 600, p25: 520, dataTimestamp: Date.now() });
  model.quoteAtPrices = async (_facts, prices) => ({
    curve: prices.map((price) => point(price, { p: price <= 660 ? 0.35 : 0.15,
      mu: price * 0.3, L: price * 0.2, U: price * 0.4 })),
    evidence: { rawSold: 4, rawUnsold: 3, independentAuctionGroups: 7 },
    dataTimestamp: Date.now(),
  });
  const premiumConfig = { ...config(false), premium: { enabled: true, minSold: 4,
    minMedian: 500, maxAskRatio: 1.25, minSaleProbability: 0.25, stepDownPct: 0.05 },
    buy: { minProfit: 200 } };
  const engine = engineFor(session, model, false, { store, config: premiumConfig });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active[0].base_amount, 660);
  for (const expected of [627, 600, 600]) {
    const auction = session.state.active.pop();
    session.state.history.push({ ...auction, status: 'settled_unsold',
      end_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await engine.runNow()).ok, true);
    assert.equal(session.state.active[0].base_amount, expected);
  }
  assert.equal(session.state.cards.length, 1);
  assert.equal(engine.getState().decisions[0].purchaseFloor, 600);
});

test('premium account keeps an expensive card when its routine model would recycle it', async () => {
  const session = fakeSession([card('rare')]);
  const model = modelFor({ rare: [] });
  model.stats = async () => ({ soldCount: 4, median: 800, p25: 600, dataTimestamp: Date.now() });
  model.quoteAtPrices = async (_facts, prices) => ({ curve: prices.map((price) =>
    point(price, { p: 0.1, mu: price * 0.1, L: 1, U: 2 })),
  evidence: { rawSold: 4 }, dataTimestamp: Date.now() });
  const premiumConfig = { ...config(false), premium: { enabled: true, minSold: 4,
    minMedian: 500, maxAskRatio: 1.25, minSaleProbability: 0.25, stepDownPct: 0.05 },
    buy: { minProfit: 200 } };
  const engine = engineFor(session, model, false, { config: premiumConfig });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active[0].base_amount, 801);
  assert.equal(engine.getState().decisions[0].premium, true);
  assert.equal(engine.getState().stats.recycled, 0);
});

test('premium first ask finds the highest integer price meeting the probability target', async () => {
  const session = fakeSession([card('rare')]);
  const model = modelFor({ rare: [point(300)] });
  model.stats = async () => ({ soldCount: 4, median: 600, p25: 500, dataTimestamp: Date.now() });
  model.quoteAtPrices = async (_facts, prices) => ({ curve: prices.map((price) =>
    point(price, { p: price <= 667 ? 0.3 : 0.2, mu: 100, L: 20, U: 50 })),
  evidence: { rawSold: 4 }, dataTimestamp: Date.now() });
  const premiumConfig = { ...config(false), premium: { enabled: true, minSold: 4,
    minMedian: 500, maxAskRatio: 1.25, minSaleProbability: 0.25, stepDownPct: 0.05 },
  buy: { minProfit: 200 } };
  const engine = engineFor(session, model, false, { config: premiumConfig });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active[0].base_amount, 667);
});

test('a bought nonpremium card is quoted and listed at its purchase profit floor', async () => {
  const session = fakeSession([card('low-median')]);
  const store = new StateStore({ file: null, eventFile: null });
  store.data.purchases = { 'copy-low-median': { cardId: 'low-median', purchasePrice: 400,
    accruedFees: 5, status: 'owned' } };
  const model = modelFor({ 'low-median': [point(450, { p: 0.9, mu: 100, L: 20, U: 30 })] });
  model.stats = async () => ({ soldCount: 4, median: 450, p25: 350, dataTimestamp: Date.now() });
  model.quoteAtPrices = async (_facts, prices) => ({ curve: prices.map((price) =>
    point(price, { p: 0.8, mu: 100, L: 20, U: 30 })),
  evidence: { rawSold: 4, independentAuctionGroups: 4 }, dataTimestamp: Date.now() });
  const premiumConfig = { ...config(false), listingFee: 2,
    premium: { enabled: true, minSold: 4, minMedian: 500, maxAskRatio: 1.25,
      minSaleProbability: 0.25, stepDownPct: 0.05 }, buy: { minProfit: 200 } };
  const engine = engineFor(session, model, false, { store, config: premiumConfig });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active[0].base_amount, 607);
  assert.equal(engine.getState().decisions[0].purchaseFloor, 607);
  assert.equal(engine.getState().stats.recycled, 0);
});

test('a bought copy keeps trying at its floor after the modeled market weakens even with premium pricing disabled', async () => {
  const session = fakeSession([card('weak-market')]);
  const store = new StateStore({ file: null, eventFile: null });
  store.data.purchases = { 'copy-weak-market': { cardId: 'weak-market', purchasePrice: 400,
    minProfit: 200, accruedFees: 0, status: 'inventory' } };
  const model = modelFor({ 'weak-market': [point(400, { p: 0.1, mu: -2, L: -4, U: -1 })] });
  model.stats = async () => ({ soldCount: 4, median: 450, p25: 350, dataTimestamp: Date.now() });
  model.quoteAtPrices = async (_facts, prices) => ({ curve: prices.map((price) =>
    point(price, { p: 0.05, mu: -3, L: -5, U: -2 })),
  evidence: { rawSold: 4, independentAuctionGroups: 4 }, dataTimestamp: Date.now() });
  const premiumConfig = { ...config(false), premium: { enabled: false, minSold: 4,
    minMedian: 500, maxAskRatio: 1.25, minSaleProbability: 0.25, stepDownPct: 0.05 },
  buy: { minProfit: 200 } };
  const engine = engineFor(session, model, false, { store, config: premiumConfig });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(session.state.active[0].base_amount, 600);
  assert.equal(engine.getState().stats.recycled, 0);
});

test('an unmatched won variant stays protected while purchase attribution is pending', async () => {
  const session = fakeSession([card('pending-win')]);
  const store = new StateStore({ file: null, eventFile: null });
  store.data.bids = { 'auction-win': { status: 'won', userCardId: null,
    cardId: 'pending-win', rarity: 'R', shiny: false, amount: 100 } };
  const model = modelFor({ 'pending-win': [] });
  const premiumConfig = { ...config(false), premium: { enabled: false, minSold: 4,
    minMedian: 500, maxAskRatio: 1.25, minSaleProbability: 0.25, stepDownPct: 0.05 },
  buy: { minProfit: 200 } };
  const engine = engineFor(session, model, false, { store, config: premiumConfig });
  assert.equal((await engine.runNow()).ok, true);
  assert.equal(engine.getState().stats.recycled, 0);
  assert.equal(engine.getState().decisions[0].action, 'queue');
});

test('accounting distinguishes pack sales from realized resale profit', async () => {
  const session = fakeSession([card('pack-card'), card('bought-card')]);
  const store = new StateStore({ file: null, eventFile: null });
  store.data.purchases = { 'copy-bought-card': { cardId: 'bought-card', purchasePrice: 400,
    minProfit: 200, accruedFees: 0, status: 'inventory' } };
  const model = modelFor({ 'pack-card': [point(250, { L: 20 })],
    'bought-card': [point(600, { L: 50 })] });
  model.stats = async ({ cardId }) => ({ soldCount: 4, median: cardId === 'pack-card' ? 200 : 450,
    p25: 150, dataTimestamp: Date.now() });
  const premiumConfig = { ...config(false), premium: { enabled: true, minSold: 4,
    minMedian: 500, maxAskRatio: 1.25, minSaleProbability: 0.25, stepDownPct: 0.05 },
  buy: { minProfit: 200 } };
  const engine = engineFor(session, model, false, { store, config: premiumConfig });
  assert.equal((await engine.runNow()).ok, true);
  for (const auction of session.state.active.splice(0)) {
    session.state.history.push({ ...auction, status: 'settled_sold',
      final_price: auction.card_id === 'pack-card' ? 300 : 650,
      end_at: new Date(Date.now() - 1000).toISOString(), bids: [{ id: 'bid' }] });
  }
  assert.equal((await engine.runNow()).ok, true);
  const accounting = engine.getState().accounting;
  assert.equal(accounting.packSalesRevenue, 300);
  assert.equal(accounting.resaleSalesRevenue, 650);
  assert.equal(accounting.resaleProfit, 250);
  assert.equal(accounting.purchasedInventoryCost, 0);
});
