import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { isHumanVerificationResponse } from './verification.js';

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const keyOf = (cardId, rarity, shiny) => `${cardId}|${rarity}|${shiny ? 1 : 0}`;
const activeBid = (bid) => bid?.status === 'leading' || bid?.status === 'uncertain';
const pendingWin = (bid) => bid?.status === 'won' && !bid.userCardId;
const salePrice = (auction) => number(auction.effective_bid ?? auction.current_bid ?? auction.base_amount, Infinity);
export const nextDealBid = (auction, increment = 1) => auction.current_bid == null
  ? number(auction.base_amount, Infinity)
  : Math.max(Math.ceil(number(auction.current_bid) * 11 / 10), number(auction.current_bid) + 1,
    number(auction.current_bid) + increment);

export function dealReserve(balance, held, purchases, buy) {
  const capital = Math.max(0, number(balance) + number(held) + number(purchases));
  return Math.max(number(buy.reserveCoins, 1000), number(buy.reserveFraction, 0.5) * capital);
}

export function dealBidCap({ safeExit, probability, listingFee, cutoff, queueDepth, slots, minProfit }) {
  if (!(safeExit > 0) || !(probability > 0)) return null;
  const attempts = 1 / probability;
  const expectedFees = number(listingFee) * attempts;
  const slotCost = Math.max(0, number(cutoff)) * attempts *
    (1 + Math.max(0, number(queueDepth)) / Math.max(1, number(slots, 5)));
  return { maxBid: Math.floor(safeExit - minProfit - expectedFees - slotCost),
    expectedFees, slotCost, attempts };
}

function quantile(prices, probability) {
  return prices[Math.max(0, Math.ceil(probability * prices.length) - 1)];
}

function median(prices) {
  const middle = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2;
}

function workerMain() {
  const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
  let statistics = new Map();
  let premium = new Set();
  let liquid = new Set();
  let builtAt = 0;
  const active = db.prepare(`SELECT rowid, id, card_id, rarity, is_shiny, title, seller_id,
    base_amount, current_bid, effective_bid, current_bidder_id, end_at, first_seen,
    q_score, pageviews, atk, def, category FROM auctions
    WHERE final=0 AND end_at>$now`);
  const activeByCard = db.prepare(`SELECT rowid, id, card_id, rarity, is_shiny, title, seller_id,
    base_amount, current_bid, effective_bid, current_bidder_id, end_at, first_seen,
    q_score, pageviews, atk, def, category FROM auctions INDEXED BY auctions_card
    WHERE card_id=$cardId AND final=0 AND end_at>$now`);
  const fresh = db.prepare(`SELECT rowid, id, card_id, rarity, is_shiny, title, seller_id,
    base_amount, current_bid, effective_bid, current_bidder_id, end_at, first_seen,
    q_score, pageviews, atk, def, category, final FROM auctions
    WHERE rowid>$cursor ORDER BY rowid LIMIT $limit`);
  const highRow = db.prepare('SELECT MAX(rowid) value FROM auctions');
  const tracked = db.prepare(`SELECT id, card_id, rarity, is_shiny, title, seller_id,
    base_amount, current_bid, effective_bid, current_bidder_id, end_at, first_seen,
    q_score, pageviews, atk, def, category, final, status FROM auctions WHERE id=$id`);

  function loadRecentStats(rows) {
    const missing = new Map();
    for (const row of rows) {
      if (!row.card_id || !row.rarity || row.is_shiny == null) continue;
      const key = keyOf(row.card_id, row.rarity, row.is_shiny);
      if (!statistics.has(key)) missing.set(key, row.card_id);
    }
    if (!missing.size) return;
    const groups = new Map();
    const cardIds = [...new Set(missing.values())];
    for (let i = 0; i < cardIds.length; i += 500) {
      const chunk = cardIds.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const sql = `SELECT card_id, rarity, is_shiny, final_price FROM auctions
        INDEXED BY auctions_sold_card_price WHERE card_id IN (${placeholders})
        AND final=1 AND status='settled_sold' AND final_price>0`;
      for (const sale of db.prepare(sql).iterate(...chunk)) {
        const key = keyOf(sale.card_id, sale.rarity, sale.is_shiny);
        if (!missing.has(key)) continue;
        let prices = groups.get(key);
        if (!prices) { prices = []; groups.set(key, prices); }
        prices.push(sale.final_price);
      }
    }
    for (const key of missing.keys()) {
      const prices = (groups.get(key) ?? []).sort((a, b) => a - b);
      statistics.set(key, { soldCount: prices.length,
        median: prices.length ? median(prices) : null,
        p25: prices.length ? quantile(prices, 0.25) : null });
    }
  }

  function rebuild(buy, premiumConfig) {
    const prices = new Map();
    const collect = (cardId, row) => {
      if (row.rarity == null || row.is_shiny == null) return;
      const key = keyOf(cardId, row.rarity, row.is_shiny);
      let group = prices.get(key);
      if (!group) { group = { cardId, rarity: row.rarity,
        shiny: Boolean(row.is_shiny), prices: [] }; prices.set(key, group); }
      group.prices.push(row.final_price);
    };
    if (buy.hybridEnabled) {
      // The broad pool needs most sold variants. Stream the table once instead
      // of tens of thousands of per-card index seeks and random table reads.
      // The existing partial price index does not cover rarity or shiny.
      const sold = db.prepare(`SELECT card_id, rarity, is_shiny, final_price FROM auctions NOT INDEXED
        WHERE final=1 AND status='settled_sold' AND final_price>0 AND card_id IS NOT NULL`);
      for (const row of sold.iterate()) collect(row.card_id, row);
    } else {
      // For the smaller legacy premium pool the covered aggregate cheaply
      // narrows cards before retrieving their exact rarity/shiny sales.
      const possible = db.prepare(`SELECT card_id, COUNT(*) sold_count,
        SUM(final_price > $threshold) high_count FROM auctions INDEXED BY auctions_sold_card_price
        WHERE final=1 AND status='settled_sold' AND final_price>0 AND card_id IS NOT NULL
        GROUP BY card_id HAVING sold_count >= $minSold AND high_count >= $minHigh`)
        .all({ threshold: premiumConfig.minMedian, minSold: premiumConfig.minSold,
          minHigh: Math.ceil(premiumConfig.minSold / 2) });
      const exact = db.prepare(`SELECT rarity, is_shiny, final_price FROM auctions INDEXED BY auctions_sold_card_price
        WHERE card_id=$cardId AND final=1 AND status='settled_sold' AND final_price>0`);
      for (const card of possible) for (const row of exact.iterate({ cardId: card.card_id })) collect(card.card_id, row);
    }
    statistics = new Map();
    const selected = [];
    const liquidSelected = [];
    for (const [key, group] of prices) {
      group.prices.sort((a, b) => a - b);
      const value = { soldCount: group.prices.length, median: median(group.prices), p25: quantile(group.prices, 0.25) };
      statistics.set(key, value);
      if (value.soldCount >= (buy.hybridEnabled ? buy.minSold : premiumConfig.minSold) && value.median > premiumConfig.minMedian)
        selected.push({ key, soldCount: value.soldCount, median: value.median });
      else if (buy.hybridEnabled && value.soldCount >= number(buy.liquidMinSold, 8))
        liquidSelected.push({ key, soldCount: value.soldCount, median: value.median });
    }
    selected.sort((a, b) => b.soldCount - a.soldCount || b.median - a.median || a.key.localeCompare(b.key));
    premium = new Set((buy.hybridEnabled ? selected : selected.slice(0, buy.topCount)).map((row) => row.key));
    liquid = new Set(liquidSelected.map((row) => row.key));
    builtAt = Date.now();
    return { variants: statistics.size, premiumVariants: premium.size, builtAt };
  }

  function scan({ cursor, buy, premiumConfig, now, watchIds = [] }) {
    let rebuilt = false;
    if (!builtAt || now - builtAt >= buy.topRefreshMinutes * 60_000) {
      rebuild(buy, premiumConfig);
      rebuilt = true;
    }
    const latestRow = Number(highRow.get().value ?? 0);
    const firstRun = cursor == null || number(cursor) > latestRow;
    const startCursor = firstRun ? latestRow : number(cursor);
    const byId = new Map();
    const rejections = [];
    const observations = [];
    const reject = (row, reason) => {
      if (rejections.length < 100) rejections.push({ auctionId: row.id, cardId: row.card_id,
        title: row.title, price: salePrice(row), reason });
    };
    function offer(row, source) {
      if (!row.id || !row.card_id || !row.rarity || row.is_shiny == null || row.end_at <= now) return;
      const key = keyOf(row.card_id, row.rarity, row.is_shiny);
      const stats = statistics.get(key);
      if (!stats || stats.soldCount < buy.minSold)
        return void reject(row, 'fewer than minimum exact-variant sales');
      const lane = stats.median > premiumConfig.minMedian ? 'premium' : 'liquid';
      if (buy.hybridEnabled && lane === 'liquid' && stats.soldCount < number(buy.liquidMinSold, 8))
        return void reject(row, 'fewer than minimum liquid exact-variant sales');
      const amount = nextDealBid(row, buy.bidIncrement);
      const profitFloor = buy.hybridEnabled
        ? number(lane === 'premium' ? buy.premiumMinProfit : buy.liquidMinProfit, lane === 'premium' ? 75 : 15)
        : buy.minProfit;
      if (amount > stats.p25 - profitFloor - number(buy.listingFee))
        return void reject(row, 'price cannot leave minimum profit at lower-quartile resale');
      const previous = byId.get(row.id);
      if (previous) { previous.sources.push(source); return; }
      byId.set(row.id, { auctionId: row.id, cardId: row.card_id, rarity: row.rarity,
        shiny: Boolean(row.is_shiny), title: row.title, sellerId: row.seller_id,
        price: salePrice(row),
        baseAmount: row.base_amount, currentBid: row.current_bid, effectiveBid: row.effective_bid,
        currentBidderId: row.current_bidder_id, endAt: row.end_at, firstSeen: row.first_seen,
        qScore: row.q_score, pageviews: row.pageviews, atk: row.atk, def: row.def,
        category: row.category, amount, soldCount: stats.soldCount,
        median: stats.median, p25: stats.p25,
        sources: [source], lane, grossHeadroom: stats.p25 - amount });
    }
    if (buy.hybridEnabled) {
      // A single active-auction pass is cheaper than a lookup for each of the
      // many proven lower-priced variants. Their membership survives feed cursors.
      for (const row of active.iterate({ now })) {
        const key = keyOf(row.card_id, row.rarity, row.is_shiny);
        if (premium.has(key)) offer(row, 'premium-pool');
        else if (liquid.has(key)) offer(row, 'liquid-pool');
      }
    } else {
      const premiumCardIds = new Set([...premium].map((key) => key.split('|')[0]));
      for (const cardId of premiumCardIds) for (const row of activeByCard.iterate({ cardId, now })) {
        if (premium.has(keyOf(row.card_id, row.rarity, row.is_shiny))) offer(row, 'premium-pool');
      }
    }
    for (const id of watchIds) {
      const row = tracked.get({ id });
      if (!row) continue;
      observations.push({ auctionId: row.id, endAt: row.end_at, final: row.final, status: row.status,
        baseAmount: row.base_amount, currentBid: row.current_bid,
        effectiveBid: row.effective_bid, currentBidderId: row.current_bidder_id });
      if (!row.final) offer(row, 'watchlist');
    }
    const recentRows = [];
    if (firstRun) for (const row of active.iterate({ now }))
      if (row.first_seen >= now - buy.freshLookbackMinutes * 60_000) recentRows.push(row);
    let nextCursor = startCursor;
    for (const row of fresh.iterate({ cursor: startCursor, limit: buy.maxRowsPerScan })) {
      nextCursor = row.rowid;
      if (row.final === 0) recentRows.push(row);
    }
    loadRecentStats(recentRows);
    for (const row of recentRows) offer(row, 'recent');
    const candidates = [...byId.values()];
    const rank = (a, b) => a.endAt - b.endAt ||
      number(b.grossHeadroom) - number(a.grossHeadroom) || a.amount - b.amount;
    const pool = candidates.filter((row) => row.sources.includes('premium-pool')).sort(rank);
    const recent = candidates.filter((row) => !row.sources.includes('premium-pool')).sort(rank);
    const selected = [];
    const limit = buy.hybridEnabled ? number(buy.maxQueueSize, 2000) : buy.maxQuotesPerScan;
    while (selected.length < limit && (pool.length || recent.length)) {
      if (pool.length) selected.push(pool.shift());
      if (recent.length && selected.length < limit) selected.push(recent.shift());
    }
    return { cursor: nextCursor, candidates: selected,
      considered: candidates.length, rejections, builtAt, premiumVariants: premium.size,
      variants: statistics.size, liquidVariants: liquid.size, observations, rebuilt };
  }

  parentPort.on('message', ({ id, type, payload }) => {
    try {
      const result = type === 'scan' ? scan(payload) : type === 'reset' ? (builtAt = 0, { ok: true }) : null;
      if (result === null) throw new Error(`unknown discovery operation ${type}`);
      parentPort.postMessage({ id, result });
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
  parentPort.postMessage({ type: 'ready' });
}

if (!isMainThread && workerData?.role === 'money-deal-discovery') workerMain();

class DiscoveryWorker {
  constructor(dbPath) {
    this.worker = new Worker(new URL(import.meta.url), { workerData: { role: 'money-deal-discovery', dbPath },
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')) });
    this.pending = new Map(); this.nextId = 1; this.closed = false;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.worker.on('message', (message) => {
      if (message.type === 'ready') return void this.resolveReady();
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      message.error ? task.reject(new Error(message.error)) : task.resolve(message.result);
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => { if (!this.closed && code !== 0) this.fail(new Error(`discovery worker exited ${code}`)); });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true; this.rejectReady(error);
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }
  async call(type, payload) {
    await this.ready;
    if (this.closed) throw new Error('discovery worker is closed');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.pending.values()) task.reject(new Error('discovery worker closed'));
    this.pending.clear();
    await this.worker.terminate();
  }
}

/** Read-only market discovery, durable bid tracking, and ending-time resale snipes. */
export function createDealEngine({ session, model, config: initialConfig, store, log = () => {}, getPortfolio,
  accountAllowed = () => true, dbPath, liveRequested = false, discovery = null, now = Date.now } = {}) {
  if (!session || !model || !initialConfig || !store || !getPortfolio) throw new Error('deal engine dependencies missing');
  let config = initialConfig;
  if (!discovery && !dbPath) throw new Error('dbPath is required for deal discovery');
  const source = discovery ?? new DiscoveryWorker(dbPath);
  store.data.bids ??= {};
  store.data.purchases ??= {};
  store.data.dealWatchlist ??= {};
  // Watches survive restarts; approval to spend must be earned again.
  for (const item of Object.values(store.data.dealWatchlist)) {
    if (item.status === 'ready') Object.assign(item, { status: 'watching',
      reason: 'waiting for a fresh buy evaluation', lastEvaluatedAt: 0, approvalSignature: null,
      maxBid: null, cautiousProfit: null, profitPerSlotHour: null, score: null, exitP: null, horizonP: null });
  }
  store.data.dealVerificationBlocked ??= Object.values(store.data.humanVerifications ?? {})
    .some((check) => /\/marketplace\/[^/]+\/bid$/.test(check.path ?? ''));
  const plans = new Map();
  const quoteCache = new Map();
  const watchers = new Map();
  const inFlightVariants = new Set();
  let started = false, paused = false, stopped = false, timer = null, scanning = null, reconciling = null;
  let lastScanAt = null, lastError = null, candidates = [], rejections = [], discoveryState = {};
  let scanStartedAt = null, lastScanDurationMs = null;
  let lastBidAt = 0, lastBalance = null;
  let bidGate = Promise.resolve();
  let liveReadsBlockedUntil = 0;
  const clockSamples = [];
  const clock = { offsetMs: 0, rttMs: 300, samples: 0 };
  function observeTiming(response) {
    const rtt = number(response?.t1, NaN) - number(response?.t0, NaN);
    let sample = null;
    if (Number.isFinite(rtt) && rtt >= 0 && rtt < 60_000) {
      sample = { at: now(), rtt };
      clockSamples.push(sample);
      while (clockSamples.length > 40) clockSamples.shift();
      const recent = clockSamples.map((sample) => sample.rtt).sort((a, b) => a - b);
      clock.rttMs = recent[Math.floor(recent.length / 2)];
    }
    const serverSecond = Date.parse(response?.date);
    if (Number.isFinite(serverSecond) && sample) {
      const offset = serverSecond + 500 - (response.t0 + response.t1) / 2;
      sample.offset = offset;
      const offsets = clockSamples.filter((sample) => Number.isFinite(sample.offset))
        .map((sample) => sample.offset).sort((a, b) => a - b);
      clock.offsetMs = offsets[Math.floor(offsets.length / 2)];
      clock.samples = offsets.length;
    }
  }
  const fireTime = (endAt) => endAt - number(buy().targetRemainingMs, 15_000) -
    ((buy().hybridEnabled ? 3 * clock.rttMs : clock.rttMs / 2) + number(buy().extraBidLatencyMs, 150)) - clock.offsetMs;
  const precheckLead = () => Math.max(number(buy().preCheckLeadMs, 5000), 2 * clock.rttMs + 1500);
  const buy = () => config.buy ?? {};
  const approvalSignature = () => JSON.stringify([buy(), config.premium, config.listingFee, config.listing?.durationMinutes]);
  const currentPortfolio = () => getPortfolio() ?? {};
  const myId = () => session.userId?.() ?? null;
  const live = () => liveRequested && config.dryRun === false && currentPortfolio().dry !== true;
  const canAct = () => !stopped && !paused && !store.data.dealVerificationBlocked && !currentPortfolio().paused && buy().enabled !== false &&
    session.hasCookie?.() && myId() && accountAllowed(myId());
  const emit = (type, fields) => { store.record?.(type, fields); store.save?.(); };
  const remaining = (auction) => auction.endAt - now() - clock.offsetMs;
  const requestBudget = (count = 1) => count * Math.max(100, clock.rttMs) + number(buy().extraBidLatencyMs, 150);
  const enoughTime = (auction, count = 1) => remaining(auction) > (buy().hybridEnabled ? requestBudget(count) : 0);
  function rememberTerminal(auction, reason) {
    const id = auction.auctionId ?? auction.id;
    if (!id) return;
    store.data.dealWatchlist[id] = { ...(store.data.dealWatchlist[id] ?? {}), ...auction,
      status: 'terminal', terminalReason: reason, terminalAt: now(), endAt: auction.endAt };
    clearPlan(id);
  }
  const planDetails = (decision) => ({ minProfit: decision.minProfit ?? number(buy().minProfit, 200),
    minRoi: decision.minRoi, lane: decision.lane, resalePlan: decision.resalePlan,
    exitP: decision.exitP, horizonP: decision.horizonP, attempts: decision.attempts,
    expectedFees: decision.expectedFees, slotCost: decision.slotCost,
    expectedSlotHours: decision.expectedSlotHours, profitPerSlotHour: decision.profitPerSlotHour,
    stressedValue: decision.stressedValue, residualValue: decision.residualValue });
  const factsOf = (auction) => ({ cardId: auction.cardId ?? auction.card_id,
    rarity: auction.rarity ?? auction.snapshot_rarity ?? auction.card?.rarity,
    shiny: Boolean(auction.shiny ?? auction.is_shiny),
    qScore: number(auction.qScore ?? auction.q_score ?? auction.card?.q_score),
    pageviews: number(auction.pageviews ?? auction.card?.pageviews),
    atk: number(auction.atk ?? auction.snapshot_atk ?? auction.card?.atk),
    def: number(auction.def ?? auction.snapshot_def ?? auction.card?.def),
    category: auction.category ?? auction.card?.category ?? '' });
  const heldAmount = () => Object.values(store.data.bids).filter(activeBid).reduce((sum, bid) => sum + number(bid.amount), 0);
  function purchasedCapital(portfolio) {
    const inventory = portfolio.inventory ?? [];
    const ids = new Set(inventory.map((card) => card.userCardId));
    let total = 0;
    for (const card of inventory) {
      const purchase = store.data.purchases[card.userCardId];
      total += number(purchase?.purchasePrice ?? card.purchaseCost);
    }
    for (const [userCardId, purchase] of Object.entries(store.data.purchases))
      if (!ids.has(userCardId) && purchase?.status !== 'sold' && purchase?.status !== 'recycled')
        total += number(purchase.purchasePrice);
    for (const bid of Object.values(store.data.bids)) if (pendingWin(bid)) total += number(bid.purchasePrice ?? bid.amount);
    return total;
  }
  function budget(amount, exceptAuctionId = null, balanceOverride = null) {
    const portfolio = currentPortfolio();
    const balance = balanceOverride ?? portfolio.balance ?? lastBalance;
    if (!Number.isFinite(Number(balance))) return { ok: false, reason: 'balance unavailable' };
    const held = heldAmount(), purchaseCost = purchasedCapital(portfolio);
    const reserve = dealReserve(balance, held, purchaseCost, buy());
    const planned = [...plans.values()].filter((p) => p.auctionId !== exceptAuctionId)
      .reduce((sum, p) => sum + p.amount, 0);
    const availableCash = Math.floor(balance - reserve - planned);
    const capacity = resaleCapacity(exceptAuctionId);
    const needsSlot = amount > 0 && !capacity.ids.has(`auction:${exceptAuctionId}`);
    const room = !buy().hybridEnabled || !needsSlot || capacity.used < capacity.limit;
    const reason = !room ? 'five-slot resale capacity is already committed'
      : amount > availableCash ? 'cash reserve or planned commitments' : null;
    return { ok: !reason, reason, balance, reserve, held, purchaseCost, planned, availableCash,
      resaleExposure: capacity.used, resaleCapacity: capacity.limit };
  }
  function resaleCapacity(exceptPlanId = null) {
    const ids = new Set();
    for (const [copyId, purchase] of Object.entries(store.data.purchases)) {
      if (['sold', 'recycled'].includes(purchase.status)) continue;
      ids.add(purchase.auctionId ? `auction:${purchase.auctionId}` : `copy:${copyId}`);
    }
    for (const card of currentPortfolio().inventory ?? []) {
      if (card.purchaseCost > 0 && !store.data.purchases[card.userCardId]) ids.add(`copy:${card.userCardId}`);
    }
    for (const [id, bid] of Object.entries(store.data.bids))
      if (activeBid(bid) || pendingWin(bid)) ids.add(`auction:${id}`);
    for (const id of plans.keys()) if (id !== exceptPlanId) ids.add(`auction:${id}`);
    const limit = Math.max(1, Math.min(5, number(currentPortfolio().slots?.max, 5), number(buy().maxResaleExposure, 5)));
    return { ids, used: ids.size, limit };
  }
  function excluded(auction) {
    if (auction.sellerId == null && auction.seller_id == null) return false;
    const seller = auction.sellerId ?? auction.seller_id;
    return seller === myId() || !accountAllowed(seller);
  }
  function reject(auction, reason) {
    rejections.unshift({ auctionId: auction.auctionId ?? auction.id, cardId: auction.cardId ?? auction.card_id,
      title: auction.title ?? auction.card?.wikipedia_title, price: auction.price ?? salePrice(auction), reason });
    if (rejections.length > 150) rejections.length = 150;
  }
  function skipSnipe(auction, reason, type = 'deal-snipe-skipped', decision = null) {
    const requiredBid = decision?.amount ?? (reason.includes('next bid exceeds cautious resale cap')
      ? minBid(auction) : null);
    const maxBid = decision?.maxBid ?? auction.maxBid ?? null;
    const currentPrice = auction.currentBid ?? auction.baseAmount ?? auction.price ?? null;
    const detail = reason.includes('next bid exceeds cautious resale cap')
      && Number.isFinite(requiredBid) && Number.isFinite(maxBid)
      ? `${reason}: needed ${requiredBid} coins, cap ${maxBid} coins${currentPrice == null ? '' : `, live price ${currentPrice} coins`}`
      : reason;
    const watched = store.data.dealWatchlist[auction.auctionId ?? auction.id];
    if (watched && watched.status !== 'terminal' && decision) {
      Object.assign(watched, decision, { reason,
        status: reason.includes('exceeds cautious resale cap') ? 'price-too-high' : 'watching',
        approvalSignature: null, approvedAmount: null, lastEvaluatedAt: now() });
    }
    reject(auction, detail);
    emit(type, { auctionId: auction.auctionId ?? auction.id,
      cardId: auction.cardId ?? auction.card_id, title: auction.title,
      rarity: auction.rarity, shiny: auction.shiny, amount: requiredBid ?? auction.amount,
      plannedAmount: auction.amount ?? null, requiredBid, maxBid, currentPrice,
      availableCash: decision?.availableCash ?? null,
      endAt: auction.endAt, reason: detail });
  }
  function cancelPlans(reason) {
    for (const plan of [...plans.values()]) {
      clearPlan(plan.auctionId);
      skipSnipe(plan, reason);
    }
  }

  async function safeQuote(auction) {
    const facts = factsOf(auction);
    if (!facts.cardId || !facts.rarity) return { reason: 'missing exact variant' };
    if (buy().hybridEnabled) {
      if (typeof model.dealQuote !== 'function') return { reason: 'hybrid pricing model unavailable' };
      const portfolio = currentPortfolio();
      const ownOutcomes = Object.entries(store.data.listings ?? {}).map(([id, item]) => ({
        ...item, id, auctionId: id, createdAt: item.createdAt, endAt: item.endAt,
        price: item.price, status: item.status }));
      const options = { buy: buy(), premiumThreshold: { ...config.premium, minSold: buy().minSold ?? config.premium?.minSold },
        listingFee: config.listingFee, cutoff: number(portfolio.cutoff?.value ?? portfolio.cutoff),
        queueDepth: portfolio.queueDepth, slots: portfolio.slots,
        durationMinutes: config.listing?.durationMinutes, ownOutcomes };
      const key = keyOf(facts.cardId, facts.rarity, facts.shiny);
      const signature = JSON.stringify([discoveryState.statsBuiltAt, facts, buy(), options.cutoff,
        options.queueDepth, options.slots, options.listingFee, config.premium, options.durationMinutes,
        ownOutcomes.filter((item) => keyOf(item.cardId, item.rarity, item.shiny) === key)
          .map((item) => [item.id, item.status, item.price, item.createdAt, item.endAt])]);
      const cached = quoteCache.get(key);
      if (cached?.signature === signature && now() - cached.at < number(buy().quoteCacheSeconds, 60) * 1000)
        return cached.value;
      let value = await model.dealQuote(facts, options);
      if (!value) value = { reason: 'hybrid pricing model unavailable' };
      if (!value.reason && Number.isFinite(config.maxMarketAgeHours) && config.maxMarketAgeHours > 0 &&
        (!Number.isFinite(value.dataTimestamp) || now() - value.dataTimestamp > config.maxMarketAgeHours * 3_600_000))
        value = { reason: 'market model is unavailable or stale' };
      if (!/unavailable|stale/.test(value.reason ?? '')) quoteCache.set(key, { signature, at: now(), value });
      if (quoteCache.size > number(buy().maxQueueSize, 2000)) quoteCache.delete(quoteCache.keys().next().value);
      return value;
    }
    const stats = await model.stats(facts);
    if (Number.isFinite(config.maxMarketAgeHours) && config.maxMarketAgeHours > 0 &&
        (!Number.isFinite(stats?.dataTimestamp) ||
          now() - stats.dataTimestamp > config.maxMarketAgeHours * 3_600_000))
      return { reason: 'market model is unavailable or stale' };
    if (number(stats?.soldCount) < number(buy().minSold, 4)) return { reason: 'insufficient exact-variant sales' };
    const p25 = Math.floor(number(stats.p25));
    if (p25 <= number(buy().minProfit, 200)) return { reason: 'lower quartile cannot clear profit floor' };
    const probability = async (price) => {
      const quote = await model.quoteAtPrices(facts, [price], {});
      return { p: number(quote.curve?.[0]?.p, -1), evidence: quote.evidence };
    };
    const first = await probability(p25);
    if (number(first.evidence?.rawSold) < 1) return { reason: 'no non-repriced sale for probability estimate' };
    const target = number(buy().exitProbability, 0.8);
    let safeExit = p25, exitP = first.p, s80 = null;
    if (first.p < target) {
      let found = 0, foundP = null;
      const slope = number(first.evidence?.logPriceSlope);
      if (slope > 0 && first.p > 0 && first.p < 1 && target > 0 && target < 1) {
        const logit = (p) => Math.log(p / (1 - p));
        const analytic = Math.floor(p25 * Math.exp((logit(first.p) - logit(target)) / slope));
        const point = Math.max(1, Math.min(p25 - 1, analytic));
        const probes = [...new Set([point - 1, point, point + 1]
          .filter((price) => price >= 1 && price < p25))];
        const quote = await model.quoteAtPrices(facts, probes, {});
        const valid = quote.curve?.filter((row) => row.p >= target)
          .sort((a, b) => b.price - a.price)[0];
        const next = quote.curve?.find((row) => row.price === (valid?.price ?? 0) + 1);
        if (valid && next && next.p < target && valid.price >= point - 1) {
          found = valid.price; foundP = valid.p;
        }
      }
      if (!found) {
        let lo = 1, hi = p25 - 1;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          const quote = await probability(mid);
          if (quote.p >= target) { found = mid; foundP = quote.p; lo = mid + 1; }
          else hi = mid - 1;
        }
      }
      if (!found) return { reason: 'no resale ask reaches target sale probability' };
      safeExit = found; exitP = foundP; s80 = found;
    }
    const portfolio = currentPortfolio();
    const cutoff = number(portfolio.cutoff?.value ?? portfolio.cutoff);
    const economics = dealBidCap({ safeExit, probability: exitP, listingFee: config.listingFee,
      cutoff, queueDepth: portfolio.queueDepth, slots: portfolio.slots?.max ?? portfolio.slots,
      minProfit: number(buy().minProfit, 200) });
    if (!(economics?.maxBid >= 1)) return { reason: 'fees and listing-slot cost consume resale margin' };
    return { ...economics, safeExit, s80, s80AtLeast: s80 == null ? p25 : null,
      exitP, p25, soldCount: stats.soldCount,
      median: stats.median, dataTimestamp: stats.dataTimestamp };
  }

  function normalizeLive(auction, bids = null) {
    return { auctionId: auction.id, cardId: auction.card_id,
      rarity: auction.snapshot_rarity ?? auction.card?.rarity, shiny: Boolean(auction.is_shiny),
      title: auction.card?.wikipedia_title ?? auction.title,
      sellerId: auction.seller_id, currentBidderId: auction.current_bidder_id,
      baseAmount: auction.base_amount, currentBid: auction.current_bid,
      effectiveBid: auction.effective_bid, endAt: Date.parse(auction.end_at),
      status: auction.status, winnerId: auction.winner_id,
      finalPrice: auction.final_price, qScore: auction.card?.q_score, pageviews: auction.card?.pageviews,
      atk: auction.snapshot_atk ?? auction.card?.atk, def: auction.snapshot_def ?? auction.card?.def,
      category: auction.card?.category, bidHistory: bids };
  }
  const minBid = (auction) => nextDealBid({ current_bid: auction.currentBid, base_amount: auction.baseAmount },
    number(buy().bidIncrement, 1));
  async function evaluate(auction) {
    if (excluded(auction)) return { reason: 'controlled account listing' };
    if (auction.currentBidderId === myId()) return { reason: 'already leading' };
    const variant = keyOf(auction.cardId, auction.rarity, auction.shiny);
    if (buy().hybridEnabled && ((currentPortfolio().inventory ?? []).some((card) =>
      keyOf(card.cardId, card.rarity, card.shiny) === variant && store.data.purchases[card.userCardId]?.status !== 'sold') ||
      Object.values(store.data.purchases).some((purchase) => !['sold', 'recycled'].includes(purchase.status) &&
        keyOf(purchase.cardId, purchase.rarity, purchase.shiny) === variant) ||
      Object.values(store.data.listings ?? {}).some((listing) => listing.status === 'active' &&
        keyOf(listing.cardId, listing.rarity, listing.shiny) === variant)))
      return { reason: 'same variant already held for resale' };
    if (Object.values(store.data.bids).some((bid) => bid.auctionId !== auction.auctionId &&
      (bid.status === 'leading' || bid.status === 'uncertain' || pendingWin(bid)) &&
      keyOf(bid.cardId, bid.rarity, bid.shiny) === variant))
      return { reason: 'same-variant purchase still pending inventory mapping' };
    if (auction.status && !['active', 'ready', 'watching', 'price-too-high'].includes(auction.status))
      return { reason: 'auction is not active' };
    if (!(auction.endAt > now())) return { reason: 'auction has ended' };
    const amount = minBid(auction);
    const quote = await safeQuote(auction);
    if (quote.reason) return quote;
    const cautiousProfit = number(quote.stressedValue, quote.safeExit) - amount - quote.expectedFees - quote.slotCost;
    const expectedSlotHours = Math.max(1 / 60, number(quote.expectedSlotHours ?? quote.chosen?.expectedSlotHours,
      number(quote.attempts, 1) * number(config.listing?.durationMinutes, 60) / 60));
    const profitPerSlotHour = cautiousProfit / expectedSlotHours;
    if (amount > quote.maxBid) return { ...quote, amount, cautiousProfit, expectedSlotHours,
      profitPerSlotHour, reason: 'next bid exceeds cautious resale cap' };
    if (buy().hybridEnabled && profitPerSlotHour < number(buy().minProfitPerSlotHour))
      return { ...quote, amount, cautiousProfit, expectedSlotHours, profitPerSlotHour,
        reason: 'expected profit is too small for a selling slot' };
    const portfolio = currentPortfolio();
    const backlog = Math.max(0, number(portfolio.queueDepth));
    const slots = Math.max(1, number(portfolio.slots?.max ?? portfolio.slots, 5));
    const score = buy().hybridEnabled ? profitPerSlotHour
      : (cautiousProfit / Math.max(1, amount)) / (1 + backlog / slots);
    return { ...quote, amount, cautiousProfit, expectedSlotHours, profitPerSlotHour, score };
  }

  function clearPlan(id) {
    const plan = plans.get(id);
    if (plan?.timer) clearTimeout(plan.timer);
    plans.delete(id);
  }
  function schedule(auction, decision, counter = false) {
    if (paused || currentPortfolio().paused) return;
    const id = auction.auctionId;
    if (decision.reason || !Number.isSafeInteger(decision.amount) || decision.amount < 1 ||
      !Number.isFinite(decision.maxBid) || decision.amount > decision.maxBid) {
      clearPlan(id);
      return void skipSnipe(auction, decision.reason ?? 'next bid exceeds cautious resale cap',
        'deal-snipe-skipped', decision);
    }
    if (buy().hybridEnabled && [...plans.values()].some((plan) => plan.auctionId !== id &&
      keyOf(plan.cardId, plan.rarity, plan.shiny) === keyOf(auction.cardId, auction.rarity, auction.shiny))) return;
    const targetFireAt = fireTime(auction.endAt);
    if (targetFireAt < now() - 1000 && auction.endAt - now() < 2500)
      return void skipSnipe(auction, 'snipe time already passed');
    const fireAt = Math.max(now(), targetFireAt);
    const old = plans.get(id);
    if (old && old.amount === decision.amount && old.endAt === auction.endAt && old.maxBid === decision.maxBid)
      return;
    clearPlan(id);
    const plan = { auctionId: id, title: auction.title, cardId: auction.cardId,
      rarity: auction.rarity, shiny: auction.shiny, amount: decision.amount, maxBid: decision.maxBid,
      safeExit: decision.safeExit, p25: decision.p25, median: decision.median,
      cautiousProfit: decision.cautiousProfit, score: decision.score, endAt: auction.endAt,
      ...planDetails(decision), fireAt, counter, sources: auction.sources ?? [], createdAt: old?.createdAt ?? now() };
    const preAt = fireAt - precheckLead();
    plan.timer = setTimeout(() => execute(id).catch((error) => {
      lastError = error.message; log(`deal snipe ${id}: ${error.message}`);
      skipSnipe(plan, `snipe execution failed: ${error.message}`, 'deal-snipe-failed'); clearPlan(id);
    }), Math.max(0, preAt - now()));
    plans.set(id, plan);
    emit('deal-planned', { auctionId: id, cardId: auction.cardId, title: auction.title,
      rarity: auction.rarity, shiny: auction.shiny, amount: plan.amount,
      maxBid: plan.maxBid, safeExit: plan.safeExit, endAt: plan.endAt, fireAt, counter });
  }

  async function fetchAuction(id) {
    if (now() < liveReadsBlockedUntil) throw new Error('live reads temporarily backed off');
    const response = await session.request('GET', `/api/marketplace/${encodeURIComponent(id)}`);
    observeTiming(response);
    if ([429, 403, 503].includes(response.status))
      liveReadsBlockedUntil = now() + (response.status === 403 ? 300_000 : 60_000);
    if (response.status !== 200 || !response.json?.auction) throw new Error(`auction lookup HTTP ${response.status}`);
    const actual = normalizeLive(response.json.auction, response.json.bids);
    const watched = store.data.dealWatchlist[id];
    if (watched && watched.status !== 'terminal') {
      const status = watched.status;
      const currentBid = Math.max(number(watched.currentBid), number(actual.currentBid)) || null;
      const endAt = Math.max(number(watched.endAt), number(actual.endAt));
      const changed = currentBid !== watched.currentBid || endAt !== watched.endAt;
      Object.assign(watched, Object.fromEntries(Object.entries(actual).filter(([, value]) => value !== undefined)),
        { status, currentBid, endAt, lastLiveAt: now() });
      if (changed) store.save?.();
    }
    return actual;
  }
  async function fetchBalance() {
    const response = await session.request('GET', '/api/wikibidous');
    observeTiming(response);
    if ([429, 403, 503].includes(response.status))
      liveReadsBlockedUntil = now() + (response.status === 403 ? 300_000 : 60_000);
    if (response.status !== 200 || !Number.isFinite(Number(response.json?.balance)))
      throw new Error(`balance lookup HTTP ${response.status}`);
    lastBalance = Number(response.json.balance);
    return lastBalance;
  }
  async function execute(id) {
    const plan = plans.get(id);
    if (!plan) return;
    if (!canAct()) return void (clearPlan(id), skipSnipe(plan, 'account paused, disconnected, or blocked'));
    let auction;
    try { auction = await fetchAuction(id); }
    catch (error) { clearPlan(id); return void skipSnipe(plan, `live pre-check failed: ${error.message}`); }
    if (plans.get(id) !== plan) return;
    if (auction.status !== 'active') {
      rememberTerminal(auction, 'live auction settled or cancelled');
      return void skipSnipe(auction, 'auction is not active');
    }
    plan.fireAt = Math.max(now(), fireTime(auction.endAt));
    if (auction.endAt !== plan.endAt) {
      clearPlan(id);
      const decision = await evaluate(auction);
      if (!decision.reason) schedule(auction, decision, plan.counter);
      else skipSnipe(auction, `auction changed: ${decision.reason}`, 'deal-snipe-skipped', decision);
      return;
    }
    const decision = await evaluate(auction);
    if (decision.reason) return void (clearPlan(id), skipSnipe(auction, decision.reason, 'deal-snipe-skipped', decision));
    const balance = await fetchBalance();
    if (plans.get(id) !== plan) return;
    const affordable = budget(decision.amount, id, balance);
    if (!affordable.ok) return void (clearPlan(id), skipSnipe(auction, affordable.reason,
      'deal-snipe-skipped', { ...decision, availableCash: affordable.availableCash }));
    // The final auction read, balance read and POST must fit before expiry.
    // Account for whole requests rather than only half a request's latency.
    if (!enoughTime(auction, 3))
      return void (clearPlan(id), skipSnipe(auction, 'insufficient time for final checks and bid'));
    const wait = Math.min(plan.fireAt, auction.endAt - clock.offsetMs - (buy().hybridEnabled ? requestBudget(3) : 0)) - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (plans.get(id) !== plan || !canAct()) {
      if (plans.get(id) === plan) { clearPlan(id); skipSnipe(plan, 'account paused, disconnected, or blocked before bid'); }
      return;
    }
    // Serialize the last checks and spending decision. Simultaneous timers
    // must not both act on a balance fetched before either POST completes.
    const submission = bidGate.then(() => submitPlan(id, plan, auction));
    bidGate = submission.catch(() => {});
    return submission;
  }
  async function submitPlan(id, plan, auction) {
    const gap = Math.max(0, number(buy().minGapBetweenBidsMs, 1500) - (now() - lastBidAt));
    if (!enoughTime(auction, 3) || remaining(auction) <= gap + (buy().hybridEnabled ? requestBudget(3) : 0))
      return void (clearPlan(id), skipSnipe(auction, 'insufficient time for final checks and bid gap'));
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    if (plans.get(id) !== plan || !canAct()) {
      if (plans.get(id) === plan) { clearPlan(id); skipSnipe(plan, 'account paused, disconnected, or blocked before bid'); }
      return;
    }
    // A counter or a slow pre-check can cross the end; the site extends active auctions, but
    // sending after a settled result is never useful.
    if (now() >= auction.endAt) return void (clearPlan(id), skipSnipe(auction, 'snipe deadline passed'));
    let current = await fetchAuction(id);
    if (plans.get(id) !== plan) return;
    if (current.status !== 'active') {
      rememberTerminal(current, 'live auction settled or cancelled');
      return void skipSnipe(current, 'auction is not active');
    }
    if (current.endAt !== auction.endAt) {
      clearPlan(id);
      const changed = await evaluate(current);
      if (!changed.reason) schedule(current, changed, plan.counter);
      else skipSnipe(current, `auction changed: ${changed.reason}`, 'deal-snipe-skipped', changed);
      return;
    }
    let finalDecision = await evaluate(current);
    if (finalDecision.reason) return void (clearPlan(id), skipSnipe(current, finalDecision.reason,
      'deal-snipe-skipped', finalDecision));
    if (!Number.isSafeInteger(finalDecision.amount) || finalDecision.amount < 1 ||
      !Number.isFinite(finalDecision.maxBid) || finalDecision.amount > finalDecision.maxBid)
      return void (clearPlan(id), skipSnipe(current, 'next bid exceeds cautious resale cap',
        'deal-snipe-skipped', finalDecision));
    if (!enoughTime(current, 2)) return void (clearPlan(id), skipSnipe(current, 'insufficient time for balance check and bid'));
    // Reserve a changed amount immediately, including while the balance read
    // is pending, so concurrent planning cannot spend its cash allowance.
    plan.amount = finalDecision.amount;
    const finalBalance = await fetchBalance();
    if (plans.get(id) !== plan) return;
    if (!canAct()) return void (clearPlan(id), skipSnipe(current, 'account paused, disconnected, or blocked before bid'));
    const finalBudget = budget(finalDecision.amount, id, finalBalance);
    if (!finalBudget.ok) return void (clearPlan(id), skipSnipe(current, finalBudget.reason,
      'deal-snipe-skipped', { ...finalDecision, availableCash: finalBudget.availableCash }));
    if (!enoughTime(current, 1)) return void (clearPlan(id), skipSnipe(current, 'snipe deadline passed before POST'));
    if (!live()) {
      store.data.bids[id] = { auctionId: id, cardId: current.cardId, rarity: current.rarity,
        shiny: current.shiny, title: current.title, amount: finalDecision.amount,
        status: 'dry-pending', maxBid: finalDecision.maxBid, safeExit: finalDecision.safeExit,
        ...planDetails(finalDecision),
        proposedAt: now(), endAt: current.endAt };
      rememberTerminal(current, 'bid proposal already tracked');
      emit('deal-dry-bid', { auctionId: id, cardId: current.cardId, title: current.title,
        rarity: current.rarity, shiny: current.shiny, endAt: current.endAt, amount: finalDecision.amount,
        maxBid: finalDecision.maxBid, safeExit: finalDecision.safeExit });
      clearPlan(id);
      watch(id);
      return;
    }
    const variant = keyOf(current.cardId, current.rarity, current.shiny);
    if (inFlightVariants.has(variant) || Object.values(store.data.bids).some((bid) =>
      bid.auctionId !== id && (activeBid(bid) || pendingWin(bid)) &&
      keyOf(bid.cardId, bid.rarity, bid.shiny) === variant))
      return void (clearPlan(id), skipSnipe(current, 'same-variant bid or purchase is still pending'));
    inFlightVariants.add(variant);
    lastBidAt = now();
    let amount = finalDecision.amount;
    let response = null, requestError = null, retryCap = finalDecision.maxBid;
    try {
      response = await session.request('POST', `/api/marketplace/${encodeURIComponent(id)}/bid`, { json: { amount } });
      observeTiming(response);
      if (response.status === 409 && response.json?.code === 'bid_too_low' &&
        Number.isInteger(response.json.min) && enoughTime(current, 3)) {
        const moved = await fetchAuction(id);
        const revised = await evaluate(moved);
        retryCap = revised.maxBid ?? retryCap;
        if (!revised.reason && moved.status === 'active' && enoughTime(moved, 2)) {
          const nextAmount = Math.max(response.json.min, revised.amount);
          const retryBalance = await fetchBalance();
          if (nextAmount <= revised.maxBid && budget(nextAmount, id, retryBalance).ok &&
            enoughTime(moved, 1) && plans.get(id) === plan && canAct()) {
            amount = nextAmount;
            current = moved;
            finalDecision = revised;
            response = await session.request('POST', `/api/marketplace/${encodeURIComponent(id)}/bid`, { json: { amount } });
            observeTiming(response);
          }
        }
      }
    } catch (error) { requestError = error; }
    finally { inFlightVariants.delete(variant); }
    const previous = store.data.bids[id];
    const bidRecord = (status) => ({ auctionId: id, cardId: current.cardId, rarity: current.rarity,
      shiny: current.shiny, title: current.title, amount, status,
      maxBid: finalDecision.maxBid, safeExit: finalDecision.safeExit,
      ...planDetails(finalDecision), counterCount: number(previous?.counterCount) + (plan.counter ? 1 : 0),
      ownedBeforeIds: previous?.ownedBeforeIds ?? (currentPortfolio().inventory ?? [])
        .filter((card) => keyOf(card.cardId, card.rarity, card.shiny) ===
          keyOf(current.cardId, current.rarity, current.shiny)).map((card) => card.userCardId),
      placedAt: now(), endAt: current.endAt });
    if (isHumanVerificationResponse(response)) {
      clearPlan(id);
      store.data.dealVerificationBlocked = true;
      store.data.dealWatchlist[id] = { ...store.data.dealWatchlist[id], ...current,
        status: 'verification-blocked', reason: 'waiting for human verification', verificationBlocked: true };
      cancelPlans('Buying is waiting for human verification.');
      emit('deal-bid-verification-blocked', { auctionId: id, cardId: current.cardId,
        title: current.title, amount, status: response.status });
      return;
    }
    rememberTerminal(current, 'bid attempt already tracked');
    if (requestError || !response || response.status >= 500 || response.status === 429 ||
      (response.status === 200 && response.json?.current_bid === undefined)) {
      clearPlan(id);
      store.data.bids[id] = bidRecord('uncertain');
      emit('deal-bid-uncertain', { auctionId: id, cardId: current.cardId, title: current.title, amount,
        reason: requestError?.message ?? `HTTP ${response?.status}` });
      try { await reconcileBid(id, store.data.bids[id]); } catch {}
      watch(id);
      return;
    }
    clearPlan(id);
    if (response.status !== 200 || response.json?.current_bid === undefined) {
      const siteMinimum = response.status === 409 && response.json?.code === 'bid_too_low'
        && Number.isInteger(response.json?.min) ? response.json.min : null;
      const failureReason = siteMinimum == null
        ? String(response.json?.error ?? response.text ?? `HTTP ${response.status}`).slice(0, 140)
        : `Site required ${siteMinimum} coins; cautious cap was ${retryCap} coins.`;
      reject(current, `bid rejected (HTTP ${response.status})`);
      emit('deal-bid-failed', { auctionId: id, cardId: current.cardId, title: current.title,
        rarity: current.rarity, shiny: current.shiny, amount, status: response.status,
        requiredBid: siteMinimum, maxBid: retryCap,
        currentPrice: current.currentBid ?? current.baseAmount ?? null, reason: failureReason });
      return;
    }
    if (Number.isFinite(Number(response.json?.bidder_balance))) lastBalance = Number(response.json.bidder_balance);
    store.data.bids[id] = bidRecord('leading');
    emit('deal-bid', { auctionId: id, cardId: current.cardId, title: current.title,
      rarity: current.rarity, shiny: current.shiny, amount, maxBid: finalDecision.maxBid,
      safeExit: finalDecision.safeExit, counter: plan.counter });
    watch(id);
  }

  async function reconcileBid(id, bid) {
    const auction = await fetchAuction(id);
    const before = bid.status;
    const priorEnd = bid.endAt;
    if (bid.status === 'dry-pending') {
      bid.endAt = auction.endAt;
      if (auction.status !== 'active') {
        bid.status = 'dry-outcome';
        bid.finalPrice = auction.finalPrice ?? auction.currentBid ?? null;
        bid.estimatedWouldWin = bid.finalPrice == null
          ? auction.status === 'settled_unsold' && bid.amount >= auction.baseAmount
          : bid.amount > bid.finalPrice;
        bid.settledAt = now();
        emit('deal-dry-outcome', { auctionId: id, cardId: bid.cardId, title: bid.title,
          proposedAmount: bid.amount, finalPrice: bid.finalPrice,
          estimatedWouldWin: bid.estimatedWouldWin, counterfactual: true });
      }
      if (bid.status !== before || bid.endAt !== priorEnd) store.save?.();
      return;
    }
    if (auction.status === 'active') {
      bid.endAt = auction.endAt;
      if (auction.currentBidderId === myId()) bid.status = 'leading';
      else {
        const ownBidRecorded = Array.isArray(auction.bidHistory) &&
          auction.bidHistory.some((entry) => entry.bidder_id === myId());
        if (bid.status === 'uncertain' && !ownBidRecorded) {
          if (now() - number(bid.placedAt) >= number(buy().uncertainHoldSeconds, 10) * 1000) {
            bid.status = 'unconfirmed';
            bid.unconfirmedAt = now();
            emit('deal-bid-unconfirmed', { auctionId: id, cardId: bid.cardId, title: bid.title,
              amount: bid.amount, reason: 'Bid request was not confirmed in the auction history.' });
          }
        } else if (bid.status !== 'unconfirmed') bid.status = 'outbid';
        if ((before === 'leading' || (before === 'uncertain' && ownBidRecorded)) && !bid.refundedAt) {
          bid.refundedAt = now(); bid.refundedAmount = bid.amount;
          emit('deal-refund-observed', { auctionId: id, cardId: bid.cardId, title: bid.title,
            amount: bid.amount, reason: 'Outbid; held coins were returned.' });
        }
        if (bid.status === 'outbid' && number(bid.counterCount) < number(buy().maxCounters, 2) &&
          !plans.has(id) && canAct()) {
          const decision = await evaluate(auction);
          if (!decision.reason) schedule(auction, decision, true);
          else skipSnipe(auction, `counter skipped: ${decision.reason}`, 'deal-snipe-skipped', decision);
        }
      }
    } else if (auction.status === 'settled_sold' && auction.winnerId === myId()) {
      bid.status = 'won'; bid.purchasePrice = auction.finalPrice ?? bid.amount;
      bid.wonAt ??= now();
      emit('deal-won', { auctionId: id, cardId: bid.cardId, title: bid.title,
        amount: bid.amount, price: bid.purchasePrice });
    } else {
      bid.status = 'lost'; bid.lostAt ??= now();
      if (before === 'leading' && !bid.refundedAt) {
        bid.refundedAt = now(); bid.refundedAmount = bid.amount;
        emit('deal-refund-observed', { auctionId: id, cardId: bid.cardId, title: bid.title,
          amount: bid.amount, reason: 'Outbid; held coins were returned.' });
      }
      emit('deal-lost', { auctionId: id, cardId: bid.cardId, title: bid.title,
        amount: bid.amount, finalPrice: auction.finalPrice ?? auction.currentBid ?? null,
        reason: auction.status === 'settled_unsold' ? 'Auction ended without a sale.' : 'Another bidder won the auction.' });
    }
    if (bid.status !== before || bid.endAt !== priorEnd) store.save?.();
  }

  function matchPurchases() {
    const inventory = currentPortfolio().inventory ?? [];
    for (const bid of Object.values(store.data.bids).filter(pendingWin)) {
      const before = new Set(bid.ownedBeforeIds ?? []);
      const matches = inventory.filter((card) =>
        keyOf(card.cardId, card.rarity, card.shiny) === keyOf(bid.cardId, bid.rarity, bid.shiny) &&
        !before.has(card.userCardId) && !store.data.purchases[card.userCardId]);
      if (matches.length !== 1) continue;
      const userCardId = matches[0].userCardId;
      store.data.purchases[userCardId] = { auctionId: bid.auctionId, userCardId,
        cardId: bid.cardId, title: bid.title || matches[0].title, rarity: bid.rarity, shiny: bid.shiny,
        purchasePrice: bid.purchasePrice ?? bid.amount, accruedFees: 0,
        minProfit: bid.minProfit, minRoi: bid.minRoi, lane: bid.lane, resalePlan: bid.resalePlan,
        safeExit: bid.safeExit, exitP: bid.exitP, horizonP: bid.horizonP,
        attempts: bid.attempts, expectedFees: bid.expectedFees, slotCost: bid.slotCost,
        stressedValue: bid.stressedValue, residualValue: bid.residualValue,
        status: 'inventory', purchasedAt: bid.wonAt ?? now() };
      bid.userCardId = userCardId;
      emit('deal-purchase-matched', { auctionId: bid.auctionId, userCardId,
        cardId: bid.cardId, price: bid.purchasePrice ?? bid.amount });
    }
  }

  const polling = new Set();
  function watch(id) {
    if (watchers.has(id) || stopped) return;
    const timer = setInterval(() => {
      const bid = store.data.bids[id];
      if (!bid || !['leading', 'outbid', 'uncertain', 'unconfirmed', 'dry-pending'].includes(bid.status) || stopped) {
        clearInterval(timer); watchers.delete(id); return;
      }
      if (polling.has(id)) return;
      if (now() < liveReadsBlockedUntil) return;
      polling.add(id);
      reconcileBid(id, bid).catch((error) => { lastError = error.message; })
        .finally(() => polling.delete(id));
    }, 1200);
    watchers.set(id, timer);
  }

  async function reconcile() {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      for (const [id, bid] of Object.entries(store.data.bids)) {
        if (!['leading', 'outbid', 'uncertain', 'unconfirmed', 'dry-pending'].includes(bid.status)) continue;
        try { await reconcileBid(id, bid); }
        catch (error) { lastError = error.message; log(`deal bid reconcile ${id}: ${error.message}`); }
        if (['leading', 'outbid', 'uncertain', 'unconfirmed', 'dry-pending'].includes(bid.status)) watch(id);
      }
      matchPurchases();
      return getState();
    })().finally(() => { reconciling = null; });
    return reconciling;
  }

  async function scan() {
    if (scanning) return scanning;
    if (stopped || buy().enabled === false) return getState();
    scanning = (async () => {
      scanStartedAt = now();
      const request = { cursor: store.data.dealsCursor ?? null,
        buy: { ...buy(), listingFee: config.listingFee },
        premiumConfig: config.premium ?? { minSold: 4, minMedian: 500 }, now: now(),
        watchIds: Object.values(store.data.dealWatchlist).filter((item) => item.status !== 'terminal')
          .map((item) => item.auctionId) };
      const found = await source.call('scan', request);
      discoveryState = { considered: found.considered, variants: found.variants,
        premiumVariants: found.premiumVariants, liquidVariants: found.liquidVariants ?? 0, statsBuiltAt: found.builtAt };
      rejections = found.rejections ?? [];
      for (const item of found.observations ?? []) {
        const prior = store.data.dealWatchlist[item.auctionId];
        if (!prior || prior.status === 'terminal') continue;
        if (item.final || (item.status && item.status !== 'active')) rememberTerminal({ ...prior, ...item }, 'auction settled or cancelled');
        else Object.assign(prior, item, { status: prior.status,
          currentBid: Math.max(number(prior.currentBid), number(item.currentBid)) || null,
          endAt: Math.max(number(prior.endAt), number(item.endAt)) });
      }
      for (const auction of found.candidates ?? []) {
        if (store.data.bids[auction.auctionId] &&
          ['leading', 'outbid', 'uncertain', 'unconfirmed', 'dry-pending', 'dry-outcome', 'won', 'lost'].includes(store.data.bids[auction.auctionId].status))
          continue;
        if (excluded(auction)) { reject(auction, 'controlled account listing'); continue; }
        const prior = store.data.dealWatchlist[auction.auctionId];
        if (prior?.status === 'terminal') continue;
        store.data.dealWatchlist[auction.auctionId] = { ...prior, ...auction,
          currentBid: Math.max(number(prior?.currentBid), number(auction.currentBid)) || null,
          endAt: Math.max(number(prior?.endAt), auction.endAt),
          firstQueuedAt: prior?.firstQueuedAt ?? now(), status: prior?.status ?? 'watching' };
      }
      for (const item of Object.values(store.data.dealWatchlist)) {
        // Marketplace bidding can extend the end. Give its live observation
        // time to catch up before retiring an unconfirmed database expiry.
        if (item.status !== 'terminal' && (!Number.isFinite(item.endAt) || item.endAt <= now() - 20_000))
          rememberTerminal(item, 'auction has ended');
      }
      // Quote work is bounded independently of the durable queue. Alternating
      // lanes prevents low prices or large absolute margins monopolising it.
      const watched = Object.values(store.data.dealWatchlist).filter((item) => item.status !== 'terminal');
      for (const item of watched) {
        const amount = minBid(item);
        if (item.status === 'ready' && (item.approvalSignature !== approvalSignature() || item.approvedAmount !== amount)) {
          const overCap = Number.isFinite(item.maxBid) && amount > item.maxBid;
          Object.assign(item, { amount, status: overCap ? 'price-too-high' : 'watching',
            reason: overCap ? 'next bid exceeds cautious resale cap' : 'waiting for a fresh buy evaluation',
            cautiousProfit: null, profitPerSlotHour: null, score: null, lastEvaluatedAt: 0, approvalSignature: null });
          clearPlan(item.auctionId);
        }
      }
      // A busy watchlist must not make an ending auction wait a full rotation.
      // Fresh urgent rows yield to the ordinary rotation until their cache ages.
      const urgentWindow = Math.max(number(buy().planningHorizonMinutes, 15) * 60_000,
        number(buy().liveRefreshLeadSeconds, 90) * 1000);
      const quoteAge = Math.max(number(buy().scanSeconds, 15), number(buy().quoteCacheSeconds, 60)) * 1000;
      const urgent = (item) => remaining(item) <= urgentWindow &&
        now() - number(item.lastEvaluatedAt) >= quoteAge;
      const rankWork = (a, b) => Number(urgent(b)) - Number(urgent(a)) ||
        number(a.lastEvaluatedAt) - number(b.lastEvaluatedAt) || a.endAt - b.endAt;
      const expensive = watched.filter((item) => item.lane !== 'liquid' && !item.verificationBlocked).sort(rankWork);
      const affordable = watched.filter((item) => item.lane === 'liquid' && !item.verificationBlocked).sort(rankWork);
      const work = [];
      const maxQuotes = Math.max(1, number(buy().maxQuotesPerScan, 240));
      while (work.length < maxQuotes && (expensive.length || affordable.length)) {
        if (expensive.length) work.push(expensive.shift());
        if (affordable.length && work.length < maxQuotes) work.push(affordable.shift());
      }
      for (const auction of work) {
        let decision;
        const evaluatedSignature = approvalSignature();
        try { decision = await evaluate(auction); }
        catch (error) { reject(auction, `model unavailable: ${error.message}`); throw error; }
        auction.lastEvaluatedAt = now();
        if (evaluatedSignature !== approvalSignature()) {
          Object.assign(auction, { status: 'watching', reason: 'buy settings changed during evaluation',
            approvalSignature: null, cautiousProfit: null, score: null, lastEvaluatedAt: 0 });
          clearPlan(auction.auctionId);
          continue;
        }
        if (decision.reason) {
          Object.assign(auction, { maxBid: null, safeExit: null, exitP: null, horizonP: null,
            minProfit: null, minRoi: null, resalePlan: null, cautiousProfit: null,
            profitPerSlotHour: null, score: null, approvalSignature: null }, decision,
            { amount: minBid(auction) });
          auction.reason = decision.reason;
          auction.status = /exceeds cautious resale cap/.test(decision.reason) ? 'price-too-high' : 'watching';
          reject(auction, decision.reason);
          // An observed unaffordable price is a reason to release capital; an
          // absent incremental-feed row is not.
          if (plans.has(auction.auctionId)) clearPlan(auction.auctionId);
          continue;
        }
        Object.assign(auction, decision, { status: 'ready', reason: null,
          approvalSignature: evaluatedSignature, approvedAmount: decision.amount });
      }
      const ready = watched.filter((item) => item.status === 'ready');
      if (buy().hybridEnabled && canAct() && now() >= liveReadsBlockedUntil) {
        const refresh = watched.filter((item) => item.status !== 'terminal' && (item.status === 'ready' || item.safeExit > 0) &&
          remaining(item) <= number(buy().liveRefreshLeadSeconds, 90) * 1000 &&
          now() - number(item.lastLiveAt) >= Math.max(5, number(buy().scanSeconds, 15)) * 1000)
          .sort((a, b) => a.endAt - b.endAt)
          .slice(0, Math.max(0, number(buy().maxLiveRefreshPerScan, 12)));
        for (const item of refresh) {
          if (now() < liveReadsBlockedUntil) break;
          if (number(buy().liveRequestGapMs, 350) > 0 && item !== refresh[0])
            await new Promise((resolve) => setTimeout(resolve, number(buy().liveRequestGapMs, 350)));
          try {
            const actual = await fetchAuction(item.auctionId);
            if (actual.status !== 'active') { rememberTerminal({ ...item, ...actual }, 'live auction settled or cancelled'); continue; }
            const evaluatedSignature = approvalSignature();
            const decision = await evaluate(actual);
            if (evaluatedSignature !== approvalSignature()) {
              Object.assign(item, { status: 'watching', reason: 'buy settings changed during evaluation',
                approvalSignature: null, cautiousProfit: null, score: null });
              clearPlan(item.auctionId);
              continue;
            }
            Object.assign(item, actual, decision, { lastLiveAt: now(), lastEvaluatedAt: now(),
              status: decision.reason ? 'price-too-high' : 'ready', reason: decision.reason ?? null,
              cautiousProfit: decision.cautiousProfit ?? null, profitPerSlotHour: decision.profitPerSlotHour ?? null,
              approvalSignature: decision.reason ? null : evaluatedSignature, approvedAmount: decision.amount });
            if (decision.reason) clearPlan(item.auctionId);
          } catch (error) { item.lastLiveError = error.message; }
        }
      }
      const portfolio = currentPortfolio();
      const balance = portfolio.balance ?? lastBalance;
      const reserve = Number.isFinite(Number(balance))
        ? dealReserve(balance, heldAmount(), purchasedCapital(portfolio), buy()) : Infinity;
      let available = Number(balance) - reserve - [...plans.values()].reduce((sum, plan) => sum + plan.amount, 0);
      const rankBuy = (a, b) => b.score - a.score || b.cautiousProfit - a.cautiousProfit || a.endAt - b.endAt;
      const premiumReady = watched.filter((item) => item.status === 'ready' && item.lane !== 'liquid').sort(rankBuy);
      const liquidReady = watched.filter((item) => item.status === 'ready' && item.lane === 'liquid').sort(rankBuy);
      const accepted = [];
      while (premiumReady.length || liquidReady.length) {
        if (premiumReady.length) accepted.push(premiumReady.shift());
        if (liquidReady.length) accepted.push(liquidReady.shift());
      }
      accepted.sort(rankBuy);
      for (const auction of accepted) {
        if (auction.approvalSignature !== approvalSignature() || auction.approvedAmount !== minBid(auction) ||
          !Number.isSafeInteger(auction.amount) || auction.amount > auction.maxBid) {
          clearPlan(auction.auctionId);
          auction.status = 'watching';
          auction.reason = 'waiting for a fresh buy evaluation';
          continue;
        }
        const prior = plans.get(auction.auctionId);
        if (buy().hybridEnabled && !prior && [...plans.values()].some((plan) =>
          keyOf(plan.cardId, plan.rarity, plan.shiny) === keyOf(auction.cardId, auction.rarity, auction.shiny))) continue;
        if (buy().hybridEnabled && !prior && remaining(auction) > number(buy().planningHorizonMinutes, 15) * 60_000) continue;
        if (buy().hybridEnabled && !prior && plans.size >= number(buy().maxPlans, 100)) continue;
        const amount = auction.amount;
        const capacityBudget = budget(amount, auction.auctionId, balance);
        if (!capacityBudget.ok) { auction.reason = capacityBudget.reason; continue; }
        const added = amount - number(prior?.amount);
        if (added > available) { auction.reason = 'cash reserve or planned commitments'; continue; }
        available -= added;
        // Funding failures are transient. The economic approval and current
        // budget have both passed, even if this row was not requoted this scan.
        auction.reason = null;
        if (canAct()) schedule(auction, auction);
      }
      const queueLimit = Math.max(plans.size, number(buy().maxQueueSize, 2000));
      const all = Object.values(store.data.dealWatchlist).sort((a, b) =>
        Number(plans.has(b.auctionId)) - Number(plans.has(a.auctionId)) ||
        Number(b.status === 'terminal' && b.endAt > now()) - Number(a.status === 'terminal' && a.endAt > now()) ||
        Number(a.status === 'terminal') - Number(b.status === 'terminal') || a.endAt - b.endAt);
      for (const item of all.slice(queueLimit)) {
        // Bound persisted metadata without removing any funded bid plan.
        if (!plans.has(item.auctionId)) delete store.data.dealWatchlist[item.auctionId];
      }
      candidates = Object.values(store.data.dealWatchlist).filter((auction) => buy().hybridEnabled
        ? auction.status !== 'terminal' : auction.status === 'ready').map((auction) => ({ auctionId: auction.auctionId,
        cardId: auction.cardId, title: auction.title, rarity: auction.rarity, shiny: auction.shiny, price: auction.price,
        endAt: auction.endAt, amount: auction.amount, maxBid: auction.maxBid,
        safeExit: auction.safeExit, exitProbability: auction.exitP, median: auction.median,
        p25: auction.p25, cautiousProfit: auction.cautiousProfit, score: auction.score,
        expectedFees: auction.expectedFees, slotCost: auction.slotCost, attempts: auction.attempts,
        horizonProbability: auction.horizonP, lane: auction.lane, minProfit: auction.minProfit, minRoi: auction.minRoi,
        stressedValue: auction.stressedValue, residualValue: auction.residualValue,
        resalePlan: auction.resalePlan, status: auction.status, reason: auction.reason,
        expectedSlotHours: auction.expectedSlotHours, profitPerSlotHour: auction.profitPerSlotHour,
        lastEvaluatedAt: auction.lastEvaluatedAt, lastLiveAt: auction.lastLiveAt,
        sources: auction.sources }));
      store.data.dealsCursor = found.cursor;
      store.save?.();
      lastScanAt = now(); lastScanDurationMs = lastScanAt - scanStartedAt; lastError = null;
      return getState();
    })().catch((error) => { lastError = error.message; log(`deal scan: ${error.message}`); return getState(); })
      .finally(() => { scanning = null; });
    return scanning;
  }

  function getState() {
    const portfolio = currentPortfolio();
    const heldBidAmount = heldAmount();
    const purchaseCost = purchasedCapital(portfolio);
    const budgetState = budget(0);
    const planned = [...plans.values()].reduce((sum, plan) => sum + plan.amount, 0);
    return { paused: paused || Boolean(portfolio.paused), verificationBlocked: Boolean(store.data.dealVerificationBlocked), live: live(), lastScanAt, lastError,
      scanning: Boolean(scanning), scanStartedAt, lastScanDurationMs,
      liveReadsBlockedUntil: liveReadsBlockedUntil > now() ? liveReadsBlockedUntil : null,
      clock: { ...clock },
      balance: budgetState.balance ?? portfolio.balance ?? null, reserve: budgetState.reserve ?? null,
      availableCash: budgetState.availableCash ?? null, heldBidAmount,
      resaleExposure: budgetState.resaleExposure, resaleCapacity: budgetState.resaleCapacity,
      committed: heldBidAmount + planned, planned, purchaseCost,
      plans: [...plans.values()].map(({ timer, ...plan }) => plan).sort((a, b) => a.fireAt - b.fireAt),
      watchCount: Object.values(store.data.dealWatchlist).filter((item) => item.status !== 'terminal').length,
      readyCount: Object.values(store.data.dealWatchlist).filter((item) => item.status === 'ready').length,
      watchingCount: Object.values(store.data.dealWatchlist).filter((item) => ['watching', 'price-too-high'].includes(item.status)).length,
      candidates: [...candidates], rejections: [...rejections],
      bids: Object.values(store.data.bids).slice(-100).reverse(),
      purchases: Object.values(store.data.purchases).slice(-100).reverse().map((purchase) => ({ ...purchase,
        title: purchase.title || store.data.bids[purchase.auctionId]?.title
          || portfolio.inventory?.find((card) => card.userCardId === purchase.userCardId)?.title })),
      discovery: { ...discoveryState } };
  }

  function start() {
    if (started || stopped) return;
    started = true;
    emit('deal-engine-started', {});
    restartTimer();
    reconcile().then(() => scan()).catch((error) => { lastError = error.message; });
  }
  function restartTimer() {
    if (timer) clearInterval(timer);
    if (!started || stopped) return;
    const period = Math.max(5, number(buy().scanSeconds, 45)) * 1000;
    timer = setInterval(() => { scan().catch(() => {}); }, period);
  }
  function pause() {
    paused = true;
    cancelPlans('Bot was paused before the planned bid.');
  }
  function resume() { paused = false; scan().catch(() => {}); }
  function retryVerification(auctionIds = []) {
    const retryIds = new Set([...auctionIds, ...Object.values(store.data.dealWatchlist)
      .filter((item) => item.verificationBlocked).map((item) => item.auctionId)]);
    let recoveredAuctions = 0;
    for (const id of retryIds) {
      const item = store.data.dealWatchlist[id];
      if (!item || store.data.bids[id] || item.endAt <= now()) continue;
      Object.assign(item, { status: 'watching', reason: null, terminalReason: null,
        terminalAt: null, verificationBlocked: false, lastEvaluatedAt: 0, lastLiveAt: 0 });
      recoveredAuctions++;
    }
    store.data.dealVerificationBlocked = false;
    liveReadsBlockedUntil = 0;
    quoteCache.clear();
    emit('deal-verification-retry-requested', { recoveredAuctions });
    if (scanning) scanning.then(() => scan()).catch(() => {});
    else scan().catch(() => {});
    return { recoveredAuctions };
  }
  async function replan() {
    cancelPlans('Plans were cleared for a fresh market evaluation.');
    await source.call('reset', {});
    return scan();
  }
  async function updateConfig(next) {
    if (!next || typeof next !== 'object') throw new Error('deal config must be an object');
    config = next;
    cancelPlans('Buying settings changed before the planned bid.');
    if (scanning) await scanning;
    cancelPlans('Buying settings changed before the planned bid.');
    restartTimer();
    try { return await replan(); }
    catch (error) { lastError = error.message; log(`deal replan: ${error.message}`); return getState(); }
  }
  async function resetForAccountSwitch() {
    paused = true;
    cancelPlans('Premium account was switched before the planned bid.');
    if (scanning) await scanning;
    if (reconciling) await reconciling;
    cancelPlans('Premium account was switched before the planned bid.');
    for (const watcher of watchers.values()) clearInterval(watcher);
    watchers.clear();
    polling.clear();
    candidates = [];
    store.data.dealWatchlist = {};
    store.data.dealVerificationBlocked = false;
    quoteCache.clear();
    rejections = [];
    discoveryState = {};
    lastScanAt = null;
    lastError = null;
    lastBidAt = 0;
    lastBalance = null;
    clockSamples.length = 0;
    clock.offsetMs = 0;
    clock.rttMs = 300;
    clock.samples = 0;
    await source.call('reset', {});
  }
  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    cancelPlans('Bot stopped before the planned bid.');
    for (const watcher of watchers.values()) clearInterval(watcher);
    watchers.clear();
    await source.close?.();
  }
  return { start, scan, reconcile, getState, pause, resume, retryVerification, stop, replan, updateConfig,
    resetForAccountSwitch };
}
