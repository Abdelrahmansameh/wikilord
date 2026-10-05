import { StateStore } from './state.js';
import { findExternalPurchaseListings, nextResaleAttempt, remapReturnedPurchases, resaleProfitFloor } from './resale-policy.js';
import { isHumanVerificationResponse } from './verification.js';
import { chooseListingDuration, DURATION_EXPERIMENT, summarizeListingDurations } from './listing-duration.js';
export { isHumanVerificationResponse } from './verification.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomMs = ([lo, hi]) => lo + Math.random() * (hi - lo);
const n = (x, fallback = 0) => Number.isFinite(Number(x)) ? Number(x) : fallback;
const settled = new Set(['settled_sold', 'settled_unsold', 'cancelled']);
const verificationKey = (method, path) => `${String(method ?? '').toUpperCase()} ${String(path ?? '')}`;

function must(status, r, context) {
  if (r.status !== status) throw new Error(`${context}: HTTP ${r.status} ${(r.json?.error ?? r.text ?? '').toString().slice(0, 140)}`);
  return r.json;
}

async function readJsonWithRetry(session, path, context, valid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try { response = await session.request('GET', path); }
    catch (error) {
      if (attempt === 2) throw new Error(`${context}: ${error.message}`);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (response.status === 200 && valid(response.json)) return response.json;
    if (attempt === 2 || response.status < 500) {
      must(200, response, context);
      throw new Error(`${context}: unexpected response`);
    }
    await sleep(500 * 2 ** attempt);
  }
}

async function fetchListings(session) {
  const j = await readJsonWithRetry(session, '/api/marketplace?page=1&limit=1&mine=1',
    'my listings', (value) => Array.isArray(value?.selling));
  return { selling: j.selling, history: j.history ?? [], max: j.maxConcurrentAuctions ?? 5 };
}

async function fetchCollection(session) {
  const cards = [];
  let pendingTrade = new Set();
  for (let page = 0; page < 200; page++) {
    const j = await readJsonWithRetry(session, `/api/my-collection?sort=rarity&page=${page}&stats=0`,
      'collection', (value) => Array.isArray(value?.collection));
    if (page === 0) pendingTrade = new Set(j.pendingTradeCardIds ?? []);
    cards.push(...j.collection);
    if (!j.collection.length || (j.total != null && cards.length >= j.total)) return { cards, pendingTrade };
  }
  throw new Error('collection exceeds 200 pages; refusing to make inventory decisions from a partial scan');
}

function factsOf(e) {
  const card = e.card ?? {};
  return {
    cardId: e.card_id,
    userCardId: e.id,
    title: card.wikipedia_title ?? '',
    rarity: card.rarity ?? '',
    shiny: Boolean(e.is_shiny),
    qScore: n(card.q_score),
    pageviews: n(card.pageviews),
    atk: n(card.atk),
    def: n(card.def),
    category: card.category ?? '',
  };
}

const pointL = (p) => Number.isFinite(p?.L) ? p.L : -Infinity;
const pointU = (p) => Number.isFinite(p?.U) ? p.U : -Infinity;
const bestBy = (points, score) => points.reduce((best, p) => score(p) > score(best) ? p : best, null);

/** Shadow value of a listing slot when useful new cards arrive faster than the slots clear. */
export function computeCutoff(arrivals, { now = Date.now(), windowHours = 48, minObservations = 12, durationMinutes = 60, slots = 5, slotSamples = [], completions = [] } = {}) {
  const since = now - windowHours * 3_600_000;
  const sample = arrivals.filter((a) => a.at >= since && a.at <= now && Number.isFinite(a.score));
  const theoreticalCapacity = slots * 60 / durationMinutes;
  let capacityPerHour = theoreticalCapacity;
  const occupancy = slotSamples.filter((s) => s.at >= since && s.at <= now);
  const completionRows = completions.filter((s) => s.settledAt >= since && s.settledAt <= now);
  if (occupancy.length >= 12 && completionRows.length >= 5) {
    const saturated = occupancy.filter((s) => s.active >= slots).length / occupancy.length;
    const observedHours = (now - occupancy[0].at) / 3_600_000;
    if (saturated >= 0.7 && observedHours >= 2) {
      const observed = completionRows.length / observedHours / saturated;
      capacityPerHour = Math.min(theoreticalCapacity, Math.max(0.1, observed));
    }
  }
  const spanHours = sample.length ? (now - sample[0].at) / 3_600_000 : 0;
  const cold = sample.length < minObservations || spanHours < Math.min(2, windowHours / 4);
  if (cold) return { value: 0, arrivalRatePerHour: null, capacityPerHour, observations: sample.length, cold: true };
  const arrivalRatePerHour = sample.length / spanHours;
  if (arrivalRatePerHour <= capacityPerHour) return { value: 0, arrivalRatePerHour, capacityPerHour, observations: sample.length, cold: false };
  const q = 1 - capacityPerHour / arrivalRatePerHour;
  const scores = sample.map((a) => a.score).sort((a, b) => a - b);
  const value = Math.max(0, scores[Math.min(scores.length - 1, Math.floor(q * scores.length))]);
  return { value, arrivalRatePerHour, capacityPerHour, observations: sample.length, cold: false };
}

function quoteOptions(config) {
  return {
    recycleValue: config.recycleValue ?? 1,
    listingFee: config.listingFee ?? 0,
    targetProbability: config.targetProbability ?? 0.8,
    outcomePenalty: config.outcomePenalty ?? 0.25,
    modelLowerPenalty: config.modelLowerPenalty ?? 0.5,
    modelUpperBonus: config.modelUpperBonus ?? 1.28,
  };
}

function eligiblePoints(quote, failed) {
  const points = (quote?.curve ?? []).filter((p) => Number.isInteger(p.price) && p.price >= 1);
  if (!failed) return points;
  // Our own failed auction is new evidence, but does not justify repeating its starting price.
  const settledEvidenceIncludesFailure = n(quote.evidence?.cardLastSettledAt, 0) >= n(failed.endAt, Infinity);
  return settledEvidenceIncludesFailure ? points : points.filter((p) => p.price < failed.price);
}

function classify(facts, quote, cutoff, failed, targetProbability = 0.8) {
  const points = eligiblePoints(quote, failed);
  const positive = points.filter((p) => p.mu > 0);
  const highProbability = positive.filter((p) => p.p >= targetProbability);
  const independentCount = Number.isFinite(quote?.evidence?.independentAuctionGroups)
    ? quote.evidence.independentAuctionGroups : quote?.evidence?.effectiveN ?? 0;
  const targetRoutine = bestBy(highProbability, pointL);
  const fallbackRoutine = bestBy(positive, pointL);
  const routine = independentCount >= 2
    ? (pointL(targetRoutine) > cutoff ? targetRoutine : fallbackRoutine) : null;
  const optimistic = bestBy(points, pointU);
  const allOptimistic = bestBy(quote?.curve ?? [], pointU);
  let action = 'queue';
  let reason = 'waiting for a listing slot';
  if (quote?.evidence?.rawSold === 0 && !['UR', 'L'].includes(facts.rarity)) {
    action = 'recycle';
    reason = 'zero recorded sales for this card variant; only UR and L are exempt';
  } else if (allOptimistic && pointU(allOptimistic) <= cutoff) {
    action = 'recycle';
    reason = 'even optimistic sale gain is below the slot cutoff';
  } else if (!points.length) {
    reason = 'unsold listing: waiting for new evidence or a lower viable price';
  } else if (independentCount < 2) {
    reason = 'thin exact-card history; eligible for an exploratory listing';
  } else if (pointL(routine) > cutoff) {
    reason = routine.p >= targetProbability
      ? 'conservative sale gain clears the slot cutoff'
      : 'conservative gain clears the cutoff; estimated sale chance misses the target';
  } else {
    reason = 'plausible upside, but routine listing is not yet justified';
  }
  const point = pointL(routine) > cutoff ? routine : optimistic;
  return {
    ...facts,
    action,
    reason,
    price: point?.price ?? null,
    p: point?.p ?? null,
    pLow: point?.pLow ?? null,
    pHigh: point?.pHigh ?? null,
    meanProceeds: point?.meanProceeds ?? null,
    mu: point?.mu ?? null,
    L: point?.L ?? null,
    U: point?.U ?? null,
    targetMet: Boolean(point && point.mu > 0 && point.p >= targetProbability),
    evidence: quote?.evidence ?? null,
    curve: quote?.curve ?? [],
    chosen: point ?? null,
    modelChosen: quote?.chosen ?? quote?.modelChosen ?? null,
    dataTimestamp: quote?.dataTimestamp ?? null,
    routine,
    optimistic,
  };
}

function selectListings(rows, { free, trialActive, routineActive, cutoff }) {
  const seenCardIds = new Set();
  const routines = rows.filter((r) => r.action === 'queue' && pointL(r.routine) > cutoff)
    .sort((a, b) => pointL(b.routine) - pointL(a.routine))
    .filter((r) => {
      if (seenCardIds.has(r.cardId)) return false;
      seenCardIds.add(r.cardId);
      return true;
    });
  const selected = routines.slice(0, free).map((row) => ({ row, point: row.routine, kind: 'routine' }));
  if (free <= 0) return selected;
  const selectedCardIds = new Set(selected.map(({ row }) => row.cardId));
  const trials = rows.filter((r) => r.action === 'queue' && pointL(r.routine) <= cutoff && pointU(r.optimistic) > cutoff)
    .filter((r) => !selectedCardIds.has(r.cardId))
    .sort((a, b) => pointU(b.optimistic) - pointU(a.optimistic));
  if (!trialActive && selected.length === free && routineActive + selected.length >= 5
    && trials.length && pointU(trials[0].optimistic) > pointL(selected.at(-1).point)) {
    // Keep one exploration slot when its upside beats the weakest new routine choice.
    selectedCardIds.delete(selected.at(-1).row.cardId);
    const trial = trials.shift();
    selected[selected.length - 1] = { row: trial, point: trial.optimistic, kind: 'trial' };
    selectedCardIds.add(trial.cardId);
  }
  for (const row of trials) {
    if (selected.length >= free) break;
    if (selectedCardIds.has(row.cardId)) continue;
    selected.push({ row, point: row.optimistic, kind: 'trial' });
    selectedCardIds.add(row.cardId);
  }
  return selected;
}

const premiumScore = (row) => row?.premiumPoint
  ? row.premiumPoint.p * row.premiumPoint.meanProceeds : -Infinity;

function selectForSlots(rows, context) {
  const selected = rows.filter((row) => row.action === 'queue' && row.premiumPoint)
    .sort((a, b) => premiumScore(b) - premiumScore(a))
    .filter((row, index, all) => all.findIndex((candidate) => candidate.cardId === row.cardId) === index)
    .slice(0, context.free)
    .map((row) => ({ row, point: row.premiumPoint, kind: 'premium' }));
  if (selected.length >= context.free) return selected;
  const chosen = new Set(selected.map(({ row }) => row.cardId));
  const purchased = rows.filter((row) => row.action === 'queue' && row.purchasePoint && !chosen.has(row.cardId))
    .sort((a, b) => premiumScore({ premiumPoint: b.purchasePoint }) - premiumScore({ premiumPoint: a.purchasePoint }));
  for (const row of purchased) {
    if (selected.length >= context.free) break;
    if (chosen.has(row.cardId)) continue;
    selected.push({ row, point: row.purchasePoint, kind: 'purchase' });
    chosen.add(row.cardId);
  }
  if (selected.length >= context.free) return selected;
  const regular = selectListings(rows.filter((row) => !chosen.has(row.cardId)), {
    ...context, free: context.free - selected.length,
  });
  return [...selected, ...regular];
}

export function premiumAskPrices(median, maxRatio, maxPrice = Infinity) {
  if (!Number.isFinite(median) || median <= 0) return [];
  const lowest = Math.floor(median) + 1;
  const highest = Math.min(Math.floor(median * maxRatio), Math.floor(maxPrice));
  if (highest < lowest) return [];
  const prices = new Set([lowest, highest]);
  for (let i = 1; i <= 25; i++) {
    const price = Math.floor(median * (1 + (maxRatio - 1) * i / 25));
    if (price >= lowest && price <= highest) prices.add(price);
  }
  return [...prices].sort((a, b) => a - b);
}

export function choosePremiumAsk(curve, minProbability, fallbackFloor = null) {
  const eligible = curve.filter((point) => Number.isInteger(point.price) && point.price >= 1
    && point.price >= (fallbackFloor ?? 1));
  if (!eligible.length) return null;
  return eligible.filter((point) => point.p >= minProbability)
    .sort((a, b) => b.price - a.price)[0]
    ?? eligible.sort((a, b) => a.price - b.price)[0];
}

async function refinePremiumQuote(model, facts, quote, options, targetProbability) {
  const points = new Map(quote.curve.map((point) => [point.price, point]));
  const sorted = [...points.values()].sort((a, b) => a.price - b.price);
  let lower = sorted[0], upper = sorted.at(-1);
  if (!lower || !upper || lower.p < targetProbability || upper.p >= targetProbability)
    return quote;
  let calculated = null;
  const slope = quote.evidence?.logPriceSlope;
  if (targetProbability > 0 && targetProbability < 1 && slope > 0 && lower.p > 0 && lower.p < 1) {
    const logit = (p) => Math.log(p / (1 - p));
    calculated = Math.floor(lower.price * Math.exp((logit(lower.p) - logit(targetProbability)) / slope));
  }
  while (upper.price - lower.price > 1) {
    let price = calculated;
    calculated = null;
    if (!Number.isSafeInteger(price) || price <= lower.price || price >= upper.price)
      price = Math.floor((lower.price + upper.price) / 2);
    let point = points.get(price);
    if (!point) {
      const probe = await model.quoteAtPrices(facts, [price], options);
      point = probe.curve[0];
      if (!point) break;
      points.set(price, point);
    }
    if (point.p >= targetProbability) lower = point;
    else upper = point;
  }
  return { ...quote, curve: [...points.values()].sort((a, b) => a.price - b.price) };
}

export function createMoneyEngine({ session, model, config, log = () => {}, store = new StateStore(), liveRequested = false, wait = sleep, accountAllowed = () => true, durationRandom = Math.random } = {}) {
  if (!session || !model || !config) throw new Error('session, model and config are required');
  let dry = !liveRequested || config.dryRun !== false;
  store.data.purchases ??= {};
  store.data.premiumCopies ??= {};
  store.data.tradeOffers ??= { acceptedCount: 0, lastCheckedAt: null, lastAcceptedAt: null,
    pending: [], recentAccepted: [], lastError: null };
  let paused = Boolean(store.data.paused);
  let busy = false;
  let timer = null;
  let tradeTimer = null;
  let tradePollBusy = false;
  let started = false;
  let lastCycleAt = null;
  let lastError = null;
  let accountProblem = null;
  const hadTrackedVerification = store.data.humanVerifications != null;
  let humanVerifications = { ...(store.data.humanVerifications ?? {}) };
  if (!hadTrackedVerification) {
    const legacy = store.data.humanVerification;
    if (legacy?.method && legacy?.path && isHumanVerificationResponse({ status: legacy.status, text: legacy.detail }))
      humanVerifications[verificationKey(legacy.method, legacy.path)] = legacy;
    for (const event of store.events ?? []) {
      if (event.type === 'human-verification' && isHumanVerificationResponse({ status: event.status, text: event.detail }))
        humanVerifications[verificationKey(event.method, event.path)] = {
          method: event.method, path: event.path, status: event.status, service: event.service,
          detail: event.detail, detectedAt: event.at, lastSeenAt: event.at };
      if (['human-verification-cleared', 'human-verification-retry-requested'].includes(event.type))
        delete humanVerifications[verificationKey(event.method, event.path)];
      if (event.type === 'pack-blocked' && event.kind === 'human' && !humanVerifications['POST /api/packs/open'])
        humanVerifications['POST /api/packs/open'] = { method: 'POST', path: '/api/packs/open',
          status: event.status, service: 'site', detail: 'Pack opening requires human verification.',
          detectedAt: event.at, lastSeenAt: event.at };
      if (event.type === 'pack-opened') delete humanVerifications['POST /api/packs/open'];
    }
  }
  store.data.humanVerifications = humanVerifications;
  const verificationList = () => Object.values(humanVerifications).sort((a, b) =>
    Number(b.lastSeenAt ?? b.detectedAt ?? 0) - Number(a.lastSeenAt ?? a.detectedAt ?? 0));
  let humanVerification = verificationList()[0] ?? null;
  store.data.humanVerification = humanVerification;
  if (!hadTrackedVerification) store.save();
  let balance = store.data.lastBalance;
  let packs = { remaining: null, blocked: null, retrying: false, retryQueued: false,
    lastOpenedAt: null, opened: store.data.stats.opened };
  if (humanVerifications['POST /api/packs/open']) {
    const issue = humanVerifications['POST /api/packs/open'];
    packs.blocked = { kind: 'human', until: Date.now() + 60 * 60_000,
      detail: issue.detail, detectedAt: issue.detectedAt };
  }
  let slots = { active: 0, max: Math.min(5, config.listing.maxConcurrent), free: 0, trialActive: 0 };
  let cutoff = computeCutoff(store.data.arrivals, {
    windowHours: config.arrivalWindowHours,
    minObservations: config.minArrivalObservations,
    durationMinutes: config.listing.durationMinutes,
    slots: Math.min(5, config.listing.maxConcurrent),
  });
  let decisions = [];
  let activeListings = [];
  let modelHealth = { quoted: 0, lastQuoteAt: null, lastQuoteError: null, dataTimestamp: null };
  let packPauseUntil = packs.blocked?.until ?? 0;
  let lastModelRefreshAt = Date.now();
  let dealEngine = null;
  let inventory = [];

  const emit = (type, data) => {
    store.record(type, data);
    log(`${type}${data?.title ? `: ${data.title}` : ''}`);
  };
  session.onResponse = ({ method, path, status, json, text, service }) => {
    const key = verificationKey(method, path);
    const html = /^\s*</.test(String(text ?? ''));
    if (isHumanVerificationResponse({ status, json, text })) {
      const detail = String(json?.error_description ?? json?.error ?? json?.message ?? text ?? 'Human verification required')
        .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
      const previous = humanVerifications[key];
      const same = previous?.method === method && previous?.path === path && previous?.detail === detail;
      humanVerifications[key] = { method, path, status, service, detail,
        detectedAt: same ? previous.detectedAt : Date.now(), lastSeenAt: Date.now() };
      humanVerification = verificationList()[0] ?? null;
      store.data.humanVerifications = humanVerifications;
      store.data.humanVerification = humanVerification;
      store.save();
      if (!same) emit('human-verification', { method, path, status, service, detail });
      return;
    }
    if (humanVerifications[key] && Number(status) >= 200 && Number(status) < 300 && !html) {
      const cleared = humanVerifications[key];
      delete humanVerifications[key];
      humanVerification = verificationList()[0] ?? null;
      store.data.humanVerifications = humanVerifications;
      store.data.humanVerification = humanVerification;
      store.save();
      emit('human-verification-cleared', { method, path, status, service,
        detail: `Verification challenge cleared at ${cleared.path}` });
    }
  };
  const refreshBalance = async () => {
    const j = must(200, await session.request('GET', '/api/wikibidous'), 'balance');
    if (typeof j?.balance !== 'number') throw new Error('balance: unexpected response');
    balance = j.balance;
    if (store.data.startBalance == null) store.data.startBalance = balance;
    store.data.lastBalance = balance;
    store.save();
  };

  async function acceptIncomingTrades() {
    const tradeConfig = config.trades;
    const status = store.data.tradeOffers;
    if (!tradeConfig?.acceptIncoming || dry || paused || !session.hasCookie?.() || tradePollBusy) return;
    const userId = session.userId?.();
    if (!userId) return;
    tradePollBusy = true;
    try {
      const response = await session.request('GET', '/api/trades');
      if (response.status !== 200 || !Array.isArray(response.json?.trades)) {
        status.lastError = `Could not read incoming trades (HTTP ${response.status})`;
        status.lastCheckedAt = Date.now();
        store.save();
        return;
      }
      const pending = response.json.trades.filter((trade) => trade?.id
        && trade.status === 'pending' && String(trade.recipient_id) === String(userId));
      status.lastCheckedAt = Date.now();
      status.pending = pending.map((trade) => ({ id: trade.id,
        from: trade.initiator?.username ?? trade.initiator?.user_metadata?.username ?? null,
        createdAt: trade.created_at ?? null, itemCount: Array.isArray(trade.items) ? trade.items.length : 0 }));
      if (!pending.length) status.lastError = null;
      store.save();
      for (const [index, trade] of pending.entries()) {
        if (paused || dry || !config.trades?.acceptIncoming || !session.hasCookie?.()) break;
        if (index && tradeConfig.acceptGapMs > 0) await wait(tradeConfig.acceptGapMs);
        const result = await session.request('PATCH', `/api/trades/${encodeURIComponent(trade.id)}`, {
          json: { action: 'accept' },
        });
        if (result.status === 200 && result.json?.status === 'accepted') {
          const acceptedAt = Date.now();
          const from = trade.initiator?.username ?? trade.initiator?.user_metadata?.username ?? null;
          status.acceptedCount = Number(status.acceptedCount ?? 0) + 1;
          status.lastAcceptedAt = acceptedAt;
          status.lastError = null;
          status.pending = status.pending.filter((offer) => offer.id !== trade.id);
          status.recentAccepted.unshift({ id: trade.id, from, acceptedAt,
            itemCount: Array.isArray(trade.items) ? trade.items.length : 0 });
          status.recentAccepted.length = Math.min(status.recentAccepted.length, 20);
          store.save();
          const itemCount = Array.isArray(trade.items) ? trade.items.length : 0;
          emit('trade-offer-accepted', { tradeId: trade.id, from, itemCount,
            reason: `Accepted incoming offer${from ? ` from ${from}` : ''} · ${itemCount} items` });
        } else {
          const reason = String(result.json?.error ?? result.json?.message ?? result.text ?? `HTTP ${result.status}`)
            .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
          status.lastError = `Trade ${trade.id}: ${reason || `HTTP ${result.status}`}`;
          store.save();
          emit('trade-offer-failed', { tradeId: trade.id, status: result.status, reason });
        }
      }
    } catch (error) {
      status.lastError = error.message;
      status.lastCheckedAt = Date.now();
      store.save();
      log(`incoming trade check: ${error.message}`);
    } finally {
      tradePollBusy = false;
    }
  }

  function scheduleTradePoll(delay = Number(config.trades?.pollSeconds ?? 30) * 1000) {
    if (tradeTimer) clearTimeout(tradeTimer);
    tradeTimer = null;
    if (!started || !config.trades?.acceptIncoming) return;
    tradeTimer = setTimeout(async () => {
      tradeTimer = null;
      await acceptIncomingTrades();
      scheduleTradePoll();
    }, Math.max(0, delay));
  }

  const purchaseFor = (facts) => store.data.purchases?.[facts.userCardId] ?? null;
  const purchaseFloor = (facts) => {
    const purchase = purchaseFor(facts);
    return resaleProfitFloor(purchase, { listingFee: config.listingFee ?? 0,
      fallbackProfit: config.buy?.minProfit ?? 200 });
  };

  async function quoteInventory(facts, liveCutoff) {
    if (Object.values(store.data.bids ?? {}).some((bid) =>
      bid.status === 'won' && !bid.userCardId && bid.cardId === facts.cardId
      && bid.rarity === facts.rarity && Boolean(bid.shiny) === facts.shiny)) {
      return { ...facts, action: 'queue', reason: 'won auction is awaiting exact copy attribution',
        curve: [], chosen: null, premium: false, special: true };
    }
    if (!purchaseFor(facts) && Object.entries(store.data.purchases ?? {}).some(([copyId, item]) =>
      item.status !== 'sold' && item.status !== 'recycled' && item.cardId === facts.cardId
      && item.rarity === facts.rarity && Boolean(item.shiny) === facts.shiny
      && !inventory.some((owned) => owned.userCardId === copyId)
      && Object.values(store.data.listings ?? {}).some((listing) => listing.userCardId === copyId
        && ['settled_unsold', 'cancelled'].includes(listing.status)))) {
      return { ...facts, action: 'queue', reason: 'returned purchased copy is awaiting unambiguous attribution',
        curve: [], chosen: null, premium: false, special: true };
    }
    const purchase = purchaseFor(facts);
    if (purchase && (purchase.resalePlan || config.buy?.hybridEnabled === true) && typeof model.dealQuote === 'function') {
      const ownOutcomes = Object.values(store.data.listings ?? {});
      // Acquisition filters control new spending. Owned copies continue their
      // recorded exits and cost floors even after buying standards tighten.
      const opts = { buy: { ...config.buy, minSold: 1, liquidMinSold: 1, minBuyers: 1, minSellers: 1 },
        premiumThreshold: { ...config.premium, minSold: 1 },
        listingFee: config.listingFee ?? 0, cutoff: liveCutoff,
        queueDepth: decisions.filter((item) => item.action === 'queue').length, slots,
        ownOutcomes, durationMinutes: config.listing.durationMinutes };
      if (!purchase.resalePlan) {
        // Existing acquisitions retain their recorded profit target. Adopt the
        // shared pricing policy without rewriting their purchase cost or fees.
        const quote = await model.dealQuote(facts, opts);
        const ask = quote.safeExit ?? purchaseFloor(facts);
        purchase.resalePlan = quote.resalePlan ?? { ask, floor: purchaseFloor(facts),
          attemptLimit: config.buy?.resaleAttempts ?? 6, stepDownPct: 0.08,
          durationMinutes: config.listing.durationMinutes, pricingVersion: 'hybrid-v1' };
        store.save();
      }
      const attempt = nextResaleAttempt(purchase, ownOutcomes, {
        liquidResaleAskRatio: config.buy?.liquidResaleAskRatio ?? 0.8,
        listingFee: config.listingFee ?? 0, fallbackProfit: config.buy?.minProfit ?? 200 });
      const base = { ...facts, action: 'queue', premium: false, purchase, special: true,
        purchaseFloor: attempt?.floor ?? purchaseFloor(facts), resaleAttempt: attempt,
        curve: [], chosen: null, routine: null, optimistic: null, price: null };
      if (!attempt || attempt.exhausted) return { ...base,
        reason: attempt?.reason ?? 'waiting for a supported acquisition resale plan' };
      const quote = await model.dealQuote(facts, { ...opts, askPrices: [attempt.price] });
      modelHealth.quoted++;
      modelHealth.lastQuoteAt = Date.now();
      const chosen = quote.curve?.find((point) => point.price === attempt.price);
      if (!chosen) return { ...base, reason: 'waiting for fresh exact-variant resale evidence',
        evidence: quote.evidence, dataTimestamp: quote.dataTimestamp };
      return { ...base, purchasePoint: chosen, chosen, price: chosen.price, p: chosen.p,
        pLow: chosen.pLow, pHigh: chosen.pHigh, horizonP: chosen.horizonP,
        meanProceeds: chosen.meanProceeds, L: chosen.L, U: chosen.U,
        curve: quote.curve, evidence: quote.evidence, dataTimestamp: quote.dataTimestamp,
        reason: attempt.failureCount ? `planned resale retry ${attempt.failureCount + 1} of ${attempt.attemptLimit}`
          : 'purchased card follows its acquisition resale plan' };
    }
    const regular = await model.quote(facts, quoteOptions(config));
    modelHealth.quoted++;
    modelHealth.lastQuoteAt = Date.now();
    const failed = store.data.lastUnsoldByCopy[facts.userCardId];
    let row = classify(facts, regular, liveCutoff, failed, config.targetProbability);
    const floor = purchaseFloor(facts);
    if (!config.premium?.enabled && floor == null) return row;
    const stats = config.premium?.enabled ? await model.stats(facts) : null;
    const qualifies = Boolean(config.premium?.enabled && stats.soldCount >= config.premium.minSold
      && stats.median > config.premium.minMedian);
    if (qualifies && !store.data.premiumCopies[facts.userCardId]) {
      store.data.premiumCopies[facts.userCardId] = { enteredAt: Date.now(), median: stats.median };
    }
    const premium = Boolean(config.premium?.enabled &&
      (qualifies || store.data.premiumCopies[facts.userCardId]));
    row = { ...row, premium, premiumStats: stats, purchase: purchaseFor(facts),
      purchaseFloor: floor, special: premium || floor != null };
    if (premium) {
      const median = stats.median ?? store.data.premiumCopies[facts.userCardId]?.median;
      const minProbability = config.premium.minSaleProbability;
      let prices;
      if (failed) {
        const lowered = Math.max(1, Math.floor(failed.price * (1 - config.premium.stepDownPct)));
        prices = [Math.max(lowered, floor ?? 1)];
      } else {
        prices = premiumAskPrices(median, config.premium.maxAskRatio);
        if (floor != null) prices = prices.filter((price) => price >= floor);
        if (!prices.length && floor != null) prices = [floor];
      }
      if (!prices.length) return { ...row, action: 'queue', reason: 'premium quote has no viable asking price' };
      const premiumOptions = {
        ...quoteOptions(config), targetProbability: minProbability,
      };
      let quote = await model.quoteAtPrices(facts, prices, premiumOptions);
      if (!failed && prices.length > 1)
        quote = await refinePremiumQuote(model, facts, quote, premiumOptions, minProbability);
      modelHealth.quoted++;
      modelHealth.lastQuoteAt = Date.now();
      const chosen = failed ? quote.curve[0]
        : choosePremiumAsk(quote.curve, minProbability, floor);
      if (!chosen) return { ...row, action: 'queue', reason: 'premium quote is unavailable' };
      return { ...row, action: 'queue', reason: failed ? 'premium relist after an unsold auction'
        : 'premium card receives an above-median first ask',
      premiumPoint: chosen, chosen, price: chosen.price, p: chosen.p,
      meanProceeds: chosen.meanProceeds, L: chosen.L, U: chosen.U,
      curve: quote.curve, evidence: quote.evidence, dataTimestamp: quote.dataTimestamp };
    }
    if (floor != null) {
      let allowed = row.curve.filter((point) => point.price >= floor);
      if (!allowed.length) {
        const aboveFloor = await model.quoteAtPrices(facts, [floor], quoteOptions(config));
        modelHealth.quoted++;
        modelHealth.lastQuoteAt = Date.now();
        allowed = aboveFloor.curve;
      }
      if (allowed.length) {
        const constrained = classify(facts, { ...regular, curve: allowed }, liveCutoff,
          failed, config.targetProbability);
        const purchasePoint = constrained.chosen ?? allowed[0];
        return { ...row, ...constrained, action: 'queue', purchasePoint,
          chosen: purchasePoint, price: purchasePoint.price, p: purchasePoint.p,
          reason: 'purchased card will relist at or above its profit floor',
          purchase: purchaseFor(facts), purchaseFloor: floor, special: true };
      }
      return { ...row, action: 'queue', reason: 'waiting for a sale price above purchase plus target profit',
        routine: null, optimistic: null, chosen: null, price: null, purchaseFloor: floor, special: true };
    }
    return row;
  }

  function expectedBalance() {
    if (store.data.startBalance == null) return null;
    const purchases = Object.values(store.data.purchases ?? {});
    const purchaseSpend = purchases.reduce((sum, purchase) => sum + Number(purchase.purchasePrice ?? 0), 0);
    const unmatchedWins = Object.values(store.data.bids ?? {}).filter((bid) => bid.status === 'won'
      && !bid.userCardId).reduce((sum, bid) => sum + Number(bid.finalPrice ?? bid.amount ?? 0), 0);
    const held = Number(dealEngine?.getState?.()?.heldBidAmount ?? 0);
    return store.data.startBalance + store.data.stats.recycleRevenue + store.data.stats.salesRevenue
      - Number(store.data.stats.listingFees ?? 0)
      - purchaseSpend - unmatchedWins - held;
  }

  function noteAccounting() {
    if (balance == null || store.data.startBalance == null) return;
    const expected = expectedBalance();
    const delta = balance - expected;
    if (delta !== store.data.lastReportedDelta) {
      store.data.lastReportedDelta = delta;
      store.save();
      if (delta !== 0) emit('balance-discrepancy', { expected, actual: balance, difference: delta });
      else emit('balance-reconciled', { balance });
    }
  }

  async function syncPacks() {
    if (dry || !config.packs.enabled || Date.now() < packPauseUntil) return;
    const userId = session.userId?.();
    if (!userId) throw new Error('pack sync needs an identifiable money-bot account');
    const j = must(200, await session.rpc('sync_profile_packs', { user_id: userId }), 'pack sync');
    if (typeof j?.packs_remaining !== 'number') throw new Error('pack sync: unexpected response');
    packs.remaining = j.packs_remaining;
    if (!j.packs_remaining) return;
    let count = 0;
    while (packs.remaining > 0 && count < config.packs.maxPerCycle && !paused && !packs.retryQueued) {
      await wait(randomMs(config.packs.gapMs));
      const r = await session.request('POST', '/api/packs/open');
      if (r.status !== 200 || !Array.isArray(r.json?.cards)) {
        const body = String(r.json?.error ?? r.text ?? '');
        const normalized = body.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const human = /captcha|human|verif|anti-bot|turnstile/i.test(normalized);
        const daily = r.status === 429 || /limite quotidienne|rate_limit_daily/i.test(body);
        packPauseUntil = Date.now() + (human ? 60 : daily ? 60 : config.packs.backoffMinutes) * 60_000;
        packs.blocked = { kind: human ? 'human' : daily ? 'daily' : 'error', until: packPauseUntil,
          detail: body.slice(0, 160), detectedAt: Date.now() };
        emit('pack-blocked', { kind: packs.blocked.kind, status: r.status });
        break;
      }
      count++;
      packs.remaining = r.json.packs_remaining ?? packs.remaining - 1;
      packs.lastOpenedAt = Date.now();
      packs.blocked = null;
      store.data.stats.opened++;
      packs.opened = store.data.stats.opened;
      store.save();
      emit('pack-opened', { cards: r.json.cards.map((c) => ({ cardId: c.id, title: c.wikipedia_title, rarity: c.rarity })) });
    }
  }

  async function reconcile(mine) {
    const liveIds = new Set(mine.selling.map((a) => a.id));
    const history = new Map((mine.history ?? []).map((a) => [a.id, a]));
    for (const item of Object.values(store.data.listings)) {
      if (item.status !== 'active' || liveIds.has(item.auctionId)) continue;
      let auction = history.get(item.auctionId);
      if (!auction || !settled.has(auction.status)) {
        try {
          const r = await session.request('GET', `/api/marketplace/${item.auctionId}`);
          auction = r.json?.auction;
        } catch {}
      }
      if (!auction || !settled.has(auction.status)) continue;
      item.status = auction.status;
      item.winnerId = auction.winner_id ?? item.winnerId ?? null;
      item.endAt = Date.parse(auction.end_at) || item.endAt;
      item.settledAt = Date.parse(auction.settled_at ?? auction.end_at) || Date.now();
      if (auction.status === 'settled_sold') {
        item.finalPrice = n(auction.final_price);
        store.data.stats.sold++;
        store.data.stats.salesRevenue += item.finalPrice;
        const purchase = store.data.purchases?.[item.userCardId];
        if (purchase && purchase.status !== 'sold') {
          purchase.status = 'sold';
          purchase.salePrice = item.finalPrice;
          purchase.soldAt = item.settledAt;
          purchase.saleAuctionId = item.auctionId;
          purchase.realizedProfit = item.finalPrice - purchase.purchasePrice - (purchase.accruedFees ?? 0);
          emit('resale-profit', { auctionId: item.auctionId, cardId: item.cardId,
            title: item.title, purchasePrice: purchase.purchasePrice,
            durationMinutes: item.durationMinutes, durationExperiment: item.durationExperiment,
            salePrice: item.finalPrice, profit: purchase.realizedProfit });
        }
      } else if (auction.status === 'settled_unsold') {
        store.data.stats.unsold++;
        store.data.lastUnsoldByCopy[item.userCardId] = { price: item.price, endAt: item.endAt ?? Date.now() };
        store.data.arrivals.push({ at: Date.now(), score: Math.max(0, n(item.L)) });
      }
      store.save();
      const duration = { durationMinutes: item.durationMinutes, durationExperiment: item.durationExperiment };
      if (auction.status === 'settled_sold') emit('sold', { auctionId: item.auctionId, cardId: item.cardId, title: item.title, price: item.finalPrice, ...duration });
      else if (auction.status === 'settled_unsold') emit('unsold', { auctionId: item.auctionId, cardId: item.cardId, title: item.title, price: item.price, ...duration });
      else emit('cancelled', { auctionId: item.auctionId, cardId: item.cardId, title: item.title, ...duration });
    }
  }

  async function recoverExternalPurchaseListings(mine) {
    const missing = Object.values(store.data.purchases ?? {}).filter((p) => !['sold', 'recycled'].includes(p.status)
      && !inventory.some((row) => row.userCardId === p.userCardId)
      && !Object.values(store.data.listings).some((a) => a.userCardId === p.userCardId && a.status === 'active'));
    if (!missing.length) return;
    let recorded = [];
    if (typeof model.purchaseAuctions === 'function') {
      try { recorded = await model.purchaseAuctions(session.userId(), missing); }
      catch (error) { log(`external purchase history: ${error.message}`); }
    }
    // Prefer current authenticated observations over analyzer snapshots.
    const auctions = [...new Map([...recorded, ...(mine.history ?? []), ...mine.selling].map((a) => [a.id, a])).values()];
    const recovered = findExternalPurchaseListings(store.data, inventory, auctions, session.userId());
    for (const { purchase, auction } of recovered) {
      const fee = config.listingFee ?? 0;
      store.data.listings[auction.id] = { auctionId: auction.id, userCardId: purchase.userCardId,
        cardId: purchase.cardId, title: purchase.title, rarity: purchase.rarity, shiny: purchase.shiny,
        price: Number(auction.listing_base_amount ?? auction.base_amount), kind: 'purchase',
        origin: 'external', attribution: 'unique-exact-variant', status: 'active',
        createdAt: Date.parse(auction.created_at), endAt: Date.parse(auction.end_at),
        durationMinutes: null, durationExperiment: null, listingFee: fee, feeSource: 'configured' };
      purchase.accruedFees = (purchase.accruedFees ?? 0) + fee;
      store.data.stats.listed++;
      store.data.stats.listingFees = (store.data.stats.listingFees ?? 0) + fee;
      store.save();
      emit('purchase-listing-recovered', { auctionId: auction.id, userCardId: purchase.userCardId,
        cardId: purchase.cardId, title: purchase.title, price: store.data.listings[auction.id].price,
        attribution: 'unique-exact-variant', listingFee: fee });
    }
    if (recovered.length) {
      await reconcile({ ...mine, history: auctions });
      activeListings = activeFrom(mine);
    }
  }

  async function captureAuctionResults() {
    const due = Object.values(store.data.listings).filter((item) => settled.has(item.status)
      && !item.bidHistoryCaptured && (item.bidDetailNextAt ?? 0) <= Date.now())
      .sort((a, b) => (a.status === 'cancelled') - (b.status === 'cancelled')
        || (a.settledAt ?? 0) - (b.settledAt ?? 0)).slice(0, 5);
    for (const item of due) {
      try {
        const response = await session.request('GET', `/api/marketplace/${encodeURIComponent(item.auctionId)}`);
        const auction = response.json?.auction;
        const bids = response.json?.bids;
        if (response.status !== 200 || auction?.id !== item.auctionId || !settled.has(auction.status)
          || !Array.isArray(bids) || (auction.status === 'settled_sold' && bids.length === 0)) {
          throw new Error(`auction result ${item.title}: incomplete detail (HTTP ${response.status})`);
        }
        emit('auction-result', {
          auctionId: item.auctionId, cardId: item.cardId, title: item.title,
          status: auction.status, startPrice: item.price, finalPrice: auction.final_price ?? null,
          bidCount: bids.length, bids: bids.map((bid) => ({
            id: bid.id, amount: bid.amount, placedAt: bid.placed_at, bidderId: bid.bidder_id ?? null,
          })),
          forecast: item.forecast ?? null,
          durationMinutes: item.durationMinutes, durationExperiment: item.durationExperiment,
        });
        item.bidHistoryCaptured = true;
        item.recordedBidCount = bids.length;
        delete item.bidDetailNextAt;
        store.save();
      } catch (error) {
        item.bidDetailTries = (item.bidDetailTries ?? 0) + 1;
        item.bidDetailNextAt = Date.now() + Math.min(60 * 60_000, 3 * 60_000 * 2 ** Math.min(item.bidDetailTries - 1, 5));
        store.save();
        log(`auction result capture: ${error.message}`);
      }
    }
  }

  function activeFrom(mine) {
    return mine.selling.map((a) => {
      const own = store.data.listings[a.id];
      const currentBid = a.current_bid == null ? null : Number(a.current_bid);
      const bidCount = a.bid_count == null ? null : Number(a.bid_count);
      if (own && currentBid != null && (own.lastObservedBid !== currentBid || own.lastObservedBidCount !== bidCount)) {
        own.lastObservedBid = currentBid;
        own.lastObservedBidCount = bidCount;
        store.save();
        emit('bid-observed', { auctionId: a.id, cardId: a.card_id, title: own.title,
          currentBid, bidCount });
      }
      return {
        auctionId: a.id, cardId: a.card_id, title: a.card?.wikipedia_title ?? own?.title ?? '',
        rarity: a.snapshot_rarity ?? own?.rarity ?? '', price: a.listing_base_amount ?? a.base_amount,
        shiny: Boolean(a.is_shiny ?? own?.shiny ?? a.card?.is_shiny),
        qScore: a.card?.q_score ?? null, pageviews: a.card?.pageviews ?? null,
        atk: a.card?.atk ?? null, def: a.card?.def ?? null, category: a.card?.category ?? '',
        endAt: a.end_at ?? null, kind: own?.kind ?? 'external',
        durationMinutes: own?.durationMinutes ?? null,
        bidCount, currentBid,
        L: own?.L ?? null, U: own?.U ?? null,
      };
    });
  }

  function noBids(auction) {
    return auction.current_bid == null && auction.current_bidder_id == null &&
      (!Number.isFinite(Number(auction.bid_count)) || Number(auction.bid_count) === 0);
  }

  async function removeOwnedListing(auctionId, { automatic = false } = {}) {
    const mine = await fetchListings(session);
    const auction = mine.selling.find((a) => a.id === auctionId);
    if (!auction) throw new Error('listing is no longer active on this account');
    if (!noBids(auction)) throw new Error('listing has a bid and cannot be removed');
    const r = await session.request('DELETE', `/api/marketplace/${encodeURIComponent(auctionId)}`);
    if (r.status !== 200) throw new Error(`remove listing: HTTP ${r.status} ${String(r.json?.error ?? r.text ?? '').slice(0, 140)}`);
    const after = await fetchListings(session);
    if (after.selling.some((a) => a.id === auctionId)) throw new Error('listing removal was not confirmed by the site');
    const own = store.data.listings[auctionId];
    if (own) {
      own.status = 'cancelled';
      own.settledAt = Date.now();
      own.bidHistoryCaptured = true;
      own.recordedBidCount = 0;
      store.save();
    }
    activeListings = activeFrom(after);
    slots.active = after.selling.length;
    slots.max = Math.min(5, config.listing.maxConcurrent, after.max);
    slots.free = Math.max(0, slots.max - slots.active);
    slots.trialActive = activeListings.filter((a) => a.kind === 'trial').length;
    emit('cancelled', { auctionId, cardId: auction.card_id,
      title: auction.card?.wikipedia_title ?? own?.title, automatic,
      durationMinutes: own?.durationMinutes, durationExperiment: own?.durationExperiment });
    emit('auction-result', { auctionId, cardId: auction.card_id,
      title: auction.card?.wikipedia_title ?? own?.title, status: 'cancelled',
      startPrice: own?.price ?? auction.listing_base_amount ?? auction.base_amount,
      finalPrice: null, bidCount: 0, bids: [], forecast: own?.forecast ?? null,
      durationMinutes: own?.durationMinutes, durationExperiment: own?.durationExperiment });
    return after;
  }

  async function recheck(facts) {
    const mine = await fetchListings(session);
    const owned = await fetchCollection(session);
    const trades = owned.pendingTrade;
    const listed = mine.selling.some((a) => a.card_id === facts.cardId);
    const pending = trades.has(facts.userCardId) || trades.has(facts.cardId);
    const stillOwned = owned.cards.some((e) => e.id === facts.userCardId && e.card_id === facts.cardId);
    return { mine, listed, pending, stillOwned };
  }

  async function listOne({ row, point, kind }, liveCutoff) {
    await wait(randomMs(config.actionGapMs));
    if (paused) return false;
    const check = await recheck(row);
    if (!check.stillOwned || check.pending || check.listed || check.mine.selling.length >= slots.max) return false;
    const updated = await quoteInventory(row, liveCutoff);
    const candidate = kind === 'premium' ? updated.premiumPoint
      : kind === 'purchase' ? updated.purchasePoint
        : kind === 'routine' ? updated.routine : updated.optimistic;
    if (!candidate || (kind === 'routine' ? pointL(candidate) <= liveCutoff
      : kind === 'trial' ? pointU(candidate) <= liveCutoff : false)) return false;
    if (updated.purchaseFloor != null && candidate.price < updated.purchaseFloor) return false;
    const forecastDurationMinutes = updated.resaleAttempt?.durationMinutes ?? config.listing.durationMinutes;
    const durationMinutes = chooseListingDuration(config, forecastDurationMinutes, durationRandom);
    const durationExperiment = config.premium?.listingDurationExperiment === true ? DURATION_EXPERIMENT : null;
    const beforeBalance = balance;
    const r = await session.request('POST', '/api/marketplace', {
      json: { card_id: row.userCardId, base_amount: candidate.price,
        duration_minutes: durationMinutes },
    });
    if (r.status !== 201 || !r.json?.auction_id) throw new Error(`listing ${row.title}: HTTP ${r.status} ${String(r.json?.error ?? r.text ?? '').slice(0, 140)}`);
    const auctionId = r.json.auction_id;
    const createdAt = Date.now();
    store.data.listings[auctionId] = {
      auctionId, userCardId: row.userCardId, cardId: row.cardId, title: row.title,
      rarity: row.rarity, shiny: row.shiny, price: candidate.price, kind,
      createdAt, endAt: createdAt + durationMinutes * 60_000,
      durationMinutes, durationExperiment, listingFee: config.listingFee ?? 0,
      status: 'active',
      L: candidate.L, U: candidate.U,
      forecast: { p: candidate.p, pLow: candidate.pLow, pHigh: candidate.pHigh,
        durationMinutes: forecastDurationMinutes,
        horizonP: candidate.horizonP ?? null, estimated: Boolean(updated.purchase?.resalePlan),
        resaleAttempt: updated.resaleAttempt?.failureCount == null ? null : updated.resaleAttempt.failureCount + 1,
        meanProceeds: candidate.meanProceeds, mu: candidate.mu, L: candidate.L, U: candidate.U,
        sigmaOutcome: candidate.sigmaOutcome, sigmaModel: candidate.sigmaModel,
        rawSold: updated.evidence?.rawSold ?? null, rawUnsold: updated.evidence?.rawUnsold ?? null,
        effectiveN: updated.evidence?.effectiveN ?? null, dataTimestamp: updated.dataTimestamp ?? null },
    };
    const purchase = store.data.purchases?.[row.userCardId];
    if (purchase) purchase.accruedFees = (purchase.accruedFees ?? 0) + (config.listingFee ?? 0);
    store.data.stats.listingFees = (store.data.stats.listingFees ?? 0) + (config.listingFee ?? 0);
    store.data.stats.listed++;
    store.save();
    row.action = 'listed';
    row.reason = `${kind} listing placed`;
    row.price = candidate.price;
    let balanceChecked = false;
    try { await refreshBalance(); balanceChecked = true; }
    catch (error) { log(`listing balance check: ${error.message}`); }
    emit('listed', { auctionId, cardId: row.cardId, title: row.title, price: candidate.price, kind,
      durationMinutes, durationExperiment, listingFee: config.listingFee ?? 0,
      forecast: store.data.listings[auctionId].forecast,
      balanceBefore: beforeBalance, balanceAfter: balanceChecked ? balance : null,
      balanceDelta: !balanceChecked || beforeBalance == null ? null : balance - beforeBalance });
    return true;
  }

  async function recycleOne(row, liveCutoff) {
    await wait(randomMs(config.actionGapMs));
    if (paused) return false;
    const check = await recheck(row);
    if (!check.stillOwned || check.pending || check.listed) return false;
    const updated = await quoteInventory(row, liveCutoff);
    if (updated.action !== 'recycle') return false;
    const before = balance;
    const r = await session.request('POST', `/api/user-cards/${row.userCardId}/discard`);
    if (r.status !== 200) {
      const error = new Error(`recycle ${row.title}: HTTP ${r.status} ${String(r.json?.error ?? r.text ?? '').slice(0, 140)}`);
      error.discardFailed = true;
      error.status = r.status;
      error.siteHtml = /^\s*</.test(String(r.text ?? ''));
      throw error;
    }
    if (typeof r.json?.balance !== 'number') throw new Error(`recycle ${row.title}: missing balance in site response`);
    balance = r.json.balance;
    store.data.lastBalance = balance;
    const gained = before == null ? config.recycleValue : Math.max(0, balance - before);
    store.data.stats.recycled++;
    store.data.stats.recycleRevenue += gained;
    store.save();
    row.action = 'recycled';
    row.reason = 'recycled after fresh listing and model checks';
    emit('recycled', { cardId: row.cardId, title: row.title, gained,
      balanceBefore: before, balanceAfter: balance });
    return true;
  }

  async function cycle() {
    if (paused || !session.hasCookie?.()) return;
    const accountId = session.userId?.();
    if (!accountId || !accountAllowed(accountId)) {
      accountProblem = 'This login belongs to another bot account. Connect a separate WikiMasters account.';
      throw new Error(accountProblem);
    }
    accountProblem = null;
    if (typeof model.health !== 'function') throw new Error('market model health check is unavailable');
    if (typeof model.refresh === 'function' && Date.now() - lastModelRefreshAt >= config.modelRefreshMinutes * 60_000) {
      await model.refresh();
      lastModelRefreshAt = Date.now();
    }
    const health = await model.health();
    modelHealth.dataTimestamp = health?.dataTimestamp ?? null;
    modelHealth.premiumCalibration = health?.premiumCalibration ?? null;
    modelHealth.premiumCalibrationReused = health?.premiumCalibrationReused ?? false;
    modelHealth.lastQuoteError = null;
    if (!Number.isFinite(modelHealth.dataTimestamp) || modelHealth.dataTimestamp <= 0)
      throw new Error('market analyzer has no settled auction data yet; waiting before opening packs');
    if (Date.now() - modelHealth.dataTimestamp > config.maxMarketAgeHours * 3_600_000)
      throw new Error(`market data is over ${config.maxMarketAgeHours} hours old; waiting for the analyzer`);
    if (typeof session.init === 'function') await session.init();
    await refreshBalance();
    await syncPacks().catch((e) => {
      packs.blocked = { kind: 'error', until: Date.now() + config.packs.backoffMinutes * 60_000, detail: e.message };
      packPauseUntil = packs.blocked.until;
      log(`packs: ${e.message}`);
    });
    const mine = await fetchListings(session);
    await reconcile(mine);
    await captureAuctionResults();
    activeListings = activeFrom(mine);
    slots = {
      active: mine.selling.length,
      max: Math.min(5, config.listing.maxConcurrent, mine.max),
      free: Math.max(0, Math.min(5, config.listing.maxConcurrent, mine.max) - mine.selling.length),
      trialActive: activeListings.filter((a) => a.kind === 'trial').length,
    };
    store.data.slotSamples.push({ at: Date.now(), active: slots.active });
    const { cards, pendingTrade } = await fetchCollection(session);
    inventory = cards.filter((entry) => entry.id && entry.card_id && entry.card).map((entry) => factsOf(entry));
    for (const remap of remapReturnedPurchases(store.data, inventory)) {
      store.save();
      emit('purchase-copy-returned', remap);
    }
    await recoverExternalPurchaseListings(mine);
    if (dealEngine?.reconcile) await dealEngine.reconcile()
      .catch((error) => { log(`deal reconciliation: ${error.message}`); });
    const listedIds = new Set(mine.selling.map((a) => a.card_id));
    const unresolved = new Set(Object.values(store.data.listings).filter((a) => a.status === 'active').map((a) => a.cardId));
    const seen = new Set(store.data.seenOwnedIds);
    const rows = [];
    const arrivals = [];
    let quoteFailed = false;
    for (const e of cards) {
      if (!e.id || !e.card_id || !e.card) continue;
      const facts = factsOf(e);
      if (listedIds.has(facts.cardId) || unresolved.has(facts.cardId)) continue;
      if (pendingTrade.has(e.id) || pendingTrade.has(e.card_id)) continue;
      try {
        const row = await quoteInventory(facts, cutoff.value);
        rows.push(row);
        if (store.data.baselineSeen && !seen.has(e.id)) {
          arrivals.push({ at: Date.now(), score: Math.max(0, pointL(row.routine)) });
        }
      } catch (err) {
        quoteFailed = true;
        modelHealth.lastQuoteError = err.message;
        rows.push({ ...facts, action: 'queue', reason: `model unavailable: ${err.message}`, price: null, curve: [] });
      }
      seen.add(e.id);
    }
    store.data.baselineSeen = true;
    store.data.seenOwnedIds = [...seen];
    store.data.arrivals.push(...arrivals);
    const oldest = Date.now() - config.arrivalWindowHours * 3_600_000;
    store.data.arrivals = store.data.arrivals.filter((a) => a.at >= oldest);
    store.data.slotSamples = store.data.slotSamples.filter((s) => s.at >= oldest);
    cutoff = computeCutoff(store.data.arrivals, {
      windowHours: config.arrivalWindowHours,
      minObservations: config.minArrivalObservations,
      durationMinutes: config.listing.durationMinutes,
      slots: slots.max,
      slotSamples: store.data.slotSamples,
      completions: Object.values(store.data.listings).filter((a) => settled.has(a.status)),
    });
    for (const row of rows) {
      if (!row.curve?.length || row.special) continue;
      const revised = classify(row, { curve: row.curve, chosen: row.modelChosen, targetMet: row.targetMet, evidence: row.evidence, dataTimestamp: row.dataTimestamp }, cutoff.value, store.data.lastUnsoldByCopy[row.userCardId], config.targetProbability);
      Object.assign(row, revised);
    }
    decisions = rows.sort((a, b) => Number(Boolean(b.premiumPoint)) - Number(Boolean(a.premiumPoint))
      || Number(Boolean(b.purchasePoint)) - Number(Boolean(a.purchasePoint))
      || premiumScore(b) - premiumScore(a)
      || pointL(b.routine) - pointL(a.routine) || pointU(b.optimistic) - pointU(a.optimistic));
    store.save();
    if (dealEngine?.scan && !quoteFailed) await dealEngine.scan()
      .catch((error) => { log(`deal scan: ${error.message}`); });
    if (dry) {
      if (quoteFailed) lastError = 'one or more inventory quotes failed; no account action would run';
      else {
        const preview = selectForSlots(rows, { free: slots.free, trialActive: slots.trialActive,
          routineActive: activeListings.filter((a) => a.kind === 'routine').length, cutoff: cutoff.value });
        for (const { row, point, kind } of preview) {
          row.action = kind === 'trial' ? 'trial' : 'list';
          row.reason = `dry-run: would place a ${kind} listing`;
          row.chosen = point;
          row.price = point.price;
        }
      }
      noteAccounting();
      return;
    }
    if (quoteFailed) {
      lastError = 'one or more inventory quotes failed; live listing and recycling are paused for this cycle';
      noteAccounting();
      return;
    }
    let actions = 0;
    let free = slots.free;
    let trialActive = slots.trialActive;
    let routineActive = activeListings.filter((a) => a.kind === 'routine').length;
    let replacementTarget = null;
    if (!paused && !packs.retryQueued && free === 0 && config.replacement?.enabled !== false) {
      const replacementScore = (r) => r.premiumPoint ? premiumScore(r)
        : r.purchasePoint ? premiumScore({ premiumPoint: r.purchasePoint })
        : pointL(r.routine) > cutoff.value ? pointL(r.routine)
        : pointU(r.optimistic) > cutoff.value && pointL(r.optimistic) > 0
          ? pointL(r.optimistic) : -Infinity;
      const challenger = rows.filter((r) => r.action === 'queue' && Number.isFinite(replacementScore(r)))
        .sort((a, b) => replacementScore(b) - replacementScore(a))[0];
      const incumbents = [];
      if (challenger) for (const a of mine.selling) {
        if (!noBids(a)) continue;
        const own = store.data.listings[a.id];
        if (!own || own.status !== 'active') continue;
        // Bought cards get their full planned listing attempt. Cancelling them
        // early neither teaches demand nor gives the resale plan time to work.
        if (config.buy?.hybridEnabled === true && store.data.purchases?.[own.userCardId]) continue;
        if (own.kind === 'premium' || own.kind === 'purchase') {
          incumbents.push({ auction: a, score: (own.forecast?.p ?? 0) * (own.forecast?.meanProceeds ?? 0) });
          continue;
        }
        try {
          const card = a.card ?? {};
          const quote = await model.quote({ cardId: a.card_id, rarity: a.snapshot_rarity ?? own.rarity,
            shiny: Boolean(a.is_shiny ?? own.shiny), qScore: n(card.q_score),
            pageviews: n(card.pageviews), atk: n(card.atk), def: n(card.def),
            category: card.category ?? '' }, quoteOptions(config));
          const price = n(a.listing_base_amount ?? a.base_amount);
          const atPrice = quote.curve.find((p) => p.price === price);
          const score = quote.evidence?.rawSold === 0 && !['UR', 'L'].includes(own.rarity)
            ? -Infinity : atPrice?.L ?? -Infinity;
          incumbents.push({ auction: a, score });
        } catch (err) { log(`active listing quote: ${err.message}`); }
      }
      incumbents.sort((a, b) => a.score - b.score);
      const incumbent = incumbents[0];
      if (challenger && incumbent) {
        const oldScore = incumbent.score;
        const minGain = config.replacement?.minGainCoins ?? 15;
        const minRatio = config.replacement?.minRatio ?? 2;
        if (replacementScore(challenger) >= Math.max(oldScore + minGain, oldScore * minRatio)) {
          try {
            await removeOwnedListing(incumbent.auction.id, { automatic: true });
            free = slots.free;
            routineActive = activeListings.filter((a) => a.kind === 'routine').length;
            trialActive = slots.trialActive;
            const routinePoint = pointL(challenger.routine) > cutoff.value ? challenger.routine : null;
            replacementTarget = { row: challenger,
              point: challenger.premiumPoint ?? challenger.purchasePoint ?? routinePoint ?? challenger.optimistic,
              kind: challenger.premiumPoint ? 'premium' : challenger.purchasePoint ? 'purchase'
                : routinePoint ? 'routine' : 'trial' };
            actions++;
          } catch (err) { lastError = err.message; log(`replace listing: ${err.message}`); }
        }
      }
    }
    const attemptedCopies = new Set();
    const listedCardIds = new Set();
    while (!paused && !packs.retryQueued && free > 0 && actions < config.maxActionsPerCycle) {
      const candidates = rows.filter((row) => !attemptedCopies.has(row.userCardId) && !listedCardIds.has(row.cardId));
      const [item] = replacementTarget ? [replacementTarget]
        : selectForSlots(candidates, { free, trialActive, routineActive, cutoff: cutoff.value });
      replacementTarget = null;
      if (!item) break;
      attemptedCopies.add(item.row.userCardId);
      try {
        if (await listOne(item, cutoff.value)) {
          actions++;
          free--;
          listedCardIds.add(item.row.cardId);
          if (item.kind === 'trial') trialActive++;
          else if (item.kind === 'routine') routineActive++;
        }
      } catch (err) { log(err.message); lastError = err.message; break; }
    }
    let discardFailures = 0;
    for (const row of rows.filter((r) => r.action === 'recycle')) {
      if (paused || packs.retryQueued || actions >= config.maxActionsPerCycle) break;
      let failure = null;
      for (let attempt = 0; attempt < 2 && !paused && !packs.retryQueued; attempt++) {
        try {
          if (await recycleOne(row, cutoff.value)) actions++;
          failure = null;
          break;
        } catch (err) {
          log(err.message);
          failure = err;
          if (!err.discardFailed || err.status === 429 || err.siteHtml || attempt === 1) break;
          emit('recycle-retry', { cardId: row.cardId, title: row.title, status: err.status });
        }
      }
      if (!failure) continue;
      lastError = failure.message;
      if (!failure.discardFailed) break;
      discardFailures++;
      emit('recycle-failed', { cardId: row.cardId, title: row.title, status: failure.status });
      if (failure.status === 429 || failure.siteHtml || discardFailures >= 3) break;
    }
    const end = await fetchListings(session);
    activeListings = activeFrom(end);
    slots.active = end.selling.length;
    slots.free = Math.max(0, slots.max - slots.active);
    slots.trialActive = activeListings.filter((a) => a.kind === 'trial').length;
    await refreshBalance().catch((e) => log(`balance: ${e.message}`));
    noteAccounting();
  }

  function getState() {
    const activeChecks = verificationList();
    if (packs.blocked?.kind === 'human' && !activeChecks.some((check) =>
      verificationKey(check.method, check.path) === 'POST /api/packs/open'))
      activeChecks.unshift({ method: 'POST', path: '/api/packs/open', status: 403, service: 'site',
        detail: packs.blocked.detail, detectedAt: packs.blocked.detectedAt ?? null });
    const currentCheck = activeChecks[0] ?? null;
    const expected = expectedBalance();
    const unexplainedDelta = expected == null || balance == null ? null : balance - expected;
    const purchases = Object.values(store.data.purchases ?? {}).map((purchase) => ({ ...purchase,
      listingFloor: resaleProfitFloor(purchase, { listingFee: config.listingFee ?? 0,
        fallbackProfit: config.buy?.minProfit ?? 200 }) }));
    const soldListings = Object.values(store.data.listings ?? {}).filter((item) => item.status === 'settled_sold');
    const resaleSalesRevenue = soldListings.filter((item) => store.data.purchases?.[item.userCardId])
      .reduce((sum, item) => sum + Number(item.finalPrice ?? 0), 0);
    const packSalesRevenue = soldListings.filter((item) => !store.data.purchases?.[item.userCardId])
      .reduce((sum, item) => sum + Number(item.finalPrice ?? 0), 0);
    return {
      mode: dry ? 'dry-run' : 'live', connected: Boolean(session.hasCookie?.()),
      account: session.username?.() ?? null, paused, busy, lastCycleAt, lastError,
      problem: accountProblem ?? (session.hasCookie?.() && !accountAllowed(session.userId?.())
        ? 'This login belongs to another bot account. Connect a separate WikiMasters account.'
        : currentCheck ? `Human verification required: ${currentCheck.detail}` : lastError),
      humanVerification: currentCheck, humanVerifications: activeChecks,
      balance, startBalance: store.data.startBalance,
      net: balance == null || store.data.startBalance == null ? null : balance - store.data.startBalance,
      accounting: { expectedBalance: expected, unexplainedDelta,
        packSalesRevenue, packRecycleRevenue: store.data.stats.recycleRevenue,
        resaleSalesRevenue,
        resaleProfit: purchases.filter((purchase) => purchase.status === 'sold')
          .reduce((sum, purchase) => sum + Number(purchase.realizedProfit ?? 0), 0),
        purchasedInventoryCost: purchases.filter((purchase) => purchase.status !== 'sold')
          .reduce((sum, purchase) => sum + Number(purchase.purchasePrice ?? 0), 0) },
      packs: { ...packs }, slots: { ...slots }, cutoff: { ...cutoff },
      stats: { ...store.data.stats }, activeListings: [...activeListings], decisions: [...decisions],
      modelHealth: { ...modelHealth }, events: [...store.events],
      listingDurationComparison: { enabled: config.premium?.listingDurationExperiment === true,
        ...summarizeListingDurations(store.data.listings, store.data.purchases) },
      deals: dealEngine?.getState?.() ?? null,
      tradeOffers: { ...store.data.tradeOffers, enabled: Boolean(config.trades?.acceptIncoming),
        pollSeconds: config.trades?.pollSeconds ?? null },
      purchases,
    };
  }

  function getPortfolio() {
    return {
      balance, cutoff: cutoff.value, slots: { ...slots }, queueDepth: decisions.filter((row) => row.action === 'queue').length,
      inventory: inventory.map((card) => ({ ...card,
        purchaseCost: store.data.purchases?.[card.userCardId]?.purchasePrice ?? 0,
        accruedFees: store.data.purchases?.[card.userCardId]?.accruedFees ?? 0 })),
      activeListings: [...activeListings], dry, paused,
    };
  }

  function setDealEngine(next) { dealEngine = next; }
  function getDeals() { return dealEngine?.getState?.() ?? null; }
  function replanDeals() { return dealEngine?.replan?.(); }
  async function updateConfig(next) {
    if (busy) throw new Error('wait for the current account cycle before changing settings');
    busy = true;
    try {
      if (dealEngine?.updateConfig) await dealEngine.updateConfig(next);
      config = next;
      dry = !liveRequested || next.dryRun !== false;
      scheduleTradePoll(0);
    } finally { busy = false; }
    if (started) setTimeout(() => runNow().catch((error) => log(`config refresh: ${error.message}`)), 0);
  }

  async function runNow() {
    if (busy) {
      try {
        await refreshListings({ allowWhileBusy: true });
        return { ok: true, alreadyRunning: true, state: getState() };
      } catch (err) {
        return { ok: false, error: err.message, state: getState() };
      }
    }
    if (paused) return { ok: false, error: 'paused', state: getState() };
    busy = true;
    try {
      lastError = null;
      await cycle();
      lastCycleAt = Date.now();
      return { ok: true, state: getState() };
    } catch (err) {
      lastError = err.message;
      log(`money cycle: ${err.message}`);
      return { ok: false, error: err.message, state: getState() };
    } finally {
      busy = false;
      if (packs.retryQueued && !paused) queueMicrotask(() => {
        launchPackRetry()?.catch((error) => log(`pack retry: ${error.message}`));
      });
    }
  }

  function launchPackRetry() {
    if (!packs.retryQueued || busy || paused) return null;
    packs.retryQueued = false;
    packs.retrying = true;
    packPauseUntil = 0;
    packs.blocked = null;
    return runNow().finally(() => { packs.retrying = false; });
  }

  function retryPacks() {
    if (paused) return { ok: false, error: 'resume the bot before retrying packs' };
    if (dry || !config.packs.enabled || !session.hasCookie?.())
      return { ok: false, error: 'live pack opening is not available' };
    if (packs.retrying) return { ok: false, error: 'pack retry is already running' };
    if (packs.retryQueued) return { ok: true, queued: true };
    if (packs.blocked?.kind !== 'human' && !/anti-bot|captcha|v[ée]rification/i.test(packs.blocked?.detail ?? ''))
      return { ok: false, error: 'there is no anti-bot pack block to retry' };
    packs.retryQueued = true;
    emit('pack-retry-requested', { queued: busy });
    const queued = busy;
    const completion = launchPackRetry();
    return { ok: true, queued, completion };
  }

  function retryVerification() {
    if (paused) return { ok: false, error: 'resume the bot before retrying' };
    if (dry || !session.hasCookie?.() || !accountAllowed(session.userId?.()))
      return { ok: false, error: 'live account actions are not available' };
    // The owner confirms the human check is complete. This acknowledges old
    // notices; only an actual API response establishes whether it cleared.
    const checks = verificationList();
    const auctionIds = checks.filter((check) => check.method === 'POST')
      .map((check) => check.path?.match(/^\/api\/marketplace\/([^/]+)\/bid$/)?.[1]).filter(Boolean);
    const retry = packs.blocked?.kind === 'human' && config.packs.enabled ? retryPacks() : null;
    for (const check of checks) {
      delete humanVerifications[verificationKey(check.method, check.path)];
      emit('human-verification-retry-requested', { method: check.method, path: check.path });
    }
    humanVerification = null;
    store.data.humanVerifications = humanVerifications;
    store.data.humanVerification = null;
    if (retry?.ok) packs.blocked = null;
    const deals = dealEngine?.retryVerification?.(auctionIds);
    store.save();
    return { ok: true, queued: Boolean(retry?.queued || busy), recoveredAuctions: deals?.recoveredAuctions ?? 0 };
  }

  async function refreshListings({ allowWhileBusy = false } = {}) {
    if ((busy && !allowWhileBusy) || !session.hasCookie?.()) return getState();
    if (!accountAllowed(session.userId?.())) throw new Error('This login belongs to another bot account');
    const ownsBusy = !busy;
    if (ownsBusy) busy = true;
    try {
      const mine = await fetchListings(session);
      await reconcile(mine);
      activeListings = activeFrom(mine);
      slots.active = mine.selling.length;
      slots.max = Math.min(5, config.listing.maxConcurrent, mine.max);
      slots.free = Math.max(0, slots.max - slots.active);
      slots.trialActive = activeListings.filter((a) => a.kind === 'trial').length;
      return getState();
    } finally { if (ownsBusy) busy = false; }
  }

  async function removeListing(auctionId) {
    if (busy) return { ok: false, error: 'bot is busy; try again' };
    if (!session.hasCookie?.() || !accountAllowed(session.userId?.()))
      return { ok: false, error: 'dedicated account is not connected' };
    busy = true;
    try {
      await removeOwnedListing(auctionId);
      return { ok: true, state: getState() };
    } catch (err) {
      return { ok: false, error: err.message, state: getState() };
    } finally { busy = false; }
  }

  function schedule() {
    if (!started) return;
    const readFailed = /^(collection|my listings):/.test(lastError ?? '');
    const delay = readFailed ? 45_000 : config.cycleMinutes * 60_000 * (0.8 + 0.4 * Math.random());
    timer = setTimeout(async () => {
      await runNow();
      schedule();
    }, delay);
  }

  function start() {
    if (started) return;
    started = true;
    setTimeout(() => { if (started) runNow(); }, 1000);
    dealEngine?.start?.();
    schedule();
    scheduleTradePoll(0);
  }

  async function stop() {
    started = false;
    if (timer) clearTimeout(timer);
    timer = null;
    if (tradeTimer) clearTimeout(tradeTimer);
    tradeTimer = null;
    await dealEngine?.stop?.();
  }

  async function resetForAccountSwitch(accountId) {
    if (busy || packs.retrying) throw new Error('wait for premium account activity to finish before switching accounts');
    pause();
    if (timer) clearTimeout(timer);
    timer = null;
    if (tradeTimer) clearTimeout(tradeTimer);
    tradeTimer = null;
    await dealEngine?.resetForAccountSwitch?.();
    const archived = store.archiveAndReset({ label: store.data.accountId ?? 'previous-account' });
    store.data.accountId = accountId;
    store.data.paused = true;
    store.save();
    lastCycleAt = null;
    lastError = null;
    accountProblem = null;
    humanVerification = null;
    humanVerifications = {};
    store.data.humanVerification = null;
    store.data.humanVerifications = humanVerifications;
    balance = null;
    packs = { remaining: null, blocked: null, retrying: false, retryQueued: false,
      lastOpenedAt: null, opened: 0 };
    slots = { active: 0, max: Math.min(5, config.listing.maxConcurrent), free: 0, trialActive: 0 };
    cutoff = computeCutoff([], { slots: slots.max });
    decisions = [];
    activeListings = [];
    inventory = [];
    modelHealth = { quoted: 0, lastQuoteAt: null, lastQuoteError: null, dataTimestamp: null };
    packPauseUntil = 0;
    paused = true;
    scheduleTradePoll();
    return archived;
  }

  function pause() { paused = true; packs.retryQueued = false; store.data.paused = true; store.save(); dealEngine?.pause?.(); return { ok: true, paused }; }
  function resume() { paused = false; store.data.paused = false; store.save(); dealEngine?.resume?.(); if (started) runNow(); scheduleTradePoll(0); return { ok: true, paused }; }
  return { start, stop, runNow, retryPacks, retryVerification, refreshListings, removeListing, getState,
    getPortfolio, setDealEngine, getDeals, replanDeals, updateConfig, pause, resume, resetForAccountSwitch };
}
