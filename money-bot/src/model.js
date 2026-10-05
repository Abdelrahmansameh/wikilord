import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { resaleHorizon } from './resale-policy.js';
import { readPremiumCalibrationCache, usablePremiumCalibration, writePremiumCalibrationCache } from './model-cache.js';

// Prices are deliberately discrete. Each point has market support, and the grid
// avoids optimizing an observational model at arbitrary extreme asking prices.
const GRID = [1, 2, 3, 4, 5, 7, 10, 14, 20, 28, 40, 56, 80, 112, 160, 225, 320,
  450, 640, 900, 1280, 1800, 2560, 3600, 5120, 7200, 10240, 14400, 20480,
  28800, 40960, 57600, 81920, 115200, 163840, 230400, 327680, 463400, 655360];
const TRAIN = `final = 1 AND status IN ('settled_sold', 'settled_unsold') AND
  base_repriced_at IS NULL AND listing_base_amount >= 1 AND card_id IS NOT NULL AND
  rarity IS NOT NULL AND is_shiny IS NOT NULL`;
const clip = (x, a, b) => Math.max(a, Math.min(b, x));
const sigmoid = (x) => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
const logit = (p) => Math.log(clip(p, 1e-6, 1 - 1e-6) / (1 - clip(p, 1e-6, 1 - 1e-6)));
const shinyCode = (s) => s === true || s === 1 || s === '1' ? 1 : 0;
const keyOf = (r, s) => `${r}|${shinyCode(s)}`;
const qBand = (q) => q == null || !Number.isFinite(Number(q)) ? -1 : clip(Math.floor(Number(q) / 20), 0, 4);
const pvBand = (v) => v == null || !Number.isFinite(Number(v)) ? -1 :
  Number(v) < 50 ? 0 : Number(v) < 200 ? 1 : Number(v) < 1000 ? 2 : Number(v) < 5000 ? 3 : 4;
const featureKey = (r, s, q, v) => `${keyOf(r, s)}|${qBand(q)}|${pvBand(v)}`;
const repeatKey = (r) => `${r.card_id}|${r.seller_id ?? ''}|${r.rarity}|${r.is_shiny}|${r.listing_base_amount}`;

function nearestIndex(price) {
  let lo = 0, hi = GRID.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (GRID[mid] < price) lo = mid + 1;
    else hi = mid;
  }
  if (lo && Math.abs(Math.log(price / GRID[lo - 1])) < Math.abs(Math.log(GRID[lo] / price))) return lo - 1;
  return lo;
}

function interpolate(values, price) {
  if (price <= GRID[0]) return values[0];
  if (price >= GRID.at(-1)) return values.at(-1);
  let lo = 0, hi = GRID.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (GRID[mid] <= price) lo = mid;
    else hi = mid;
  }
  const t = Math.log(price / GRID[lo]) / Math.log(GRID[hi] / GRID[lo]);
  return values[lo] + t * (values[hi] - values[lo]);
}

function weightedQuantile(sorted, probability) {
  const total = sorted.reduce((n, x) => n + x.w, 0);
  if (!total) return null;
  const target = total * probability;
  let seen = 0;
  for (const x of sorted) {
    seen += x.w;
    if (seen >= target) return x.v;
  }
  return sorted.at(-1).v;
}

function emptyGroup() {
  return { n: Array(GRID.length).fill(0), sold: Array(GRID.length).fill(0),
    saleValues: Array.from({ length: GRID.length }, () => []), total: 0, soldTotal: 0,
    curve: null, proceeds: null, variance: null, proceedsN: null, p95Final: null };
}

// Weighted pool-adjacent-violators fit for a decreasing sale curve. Missing
// cells inherit a log-price interpolation; the within-card slope later provides
// a conservative decline through weakly observed price ranges.
function isotonicRates(n, sold) {
  const observations = [];
  for (let i = 0; i < GRID.length; i++) {
    if (n[i] <= 0) continue;
    observations.push({ i, weight: n[i] + 1, rate: (sold[i] + 0.5) / (n[i] + 1) });
  }
  if (!observations.length) return Array(GRID.length).fill(0.5);
  const blocks = [];
  for (const o of observations) {
    blocks.push({ from: o.i, to: o.i, sum: o.rate * o.weight, weight: o.weight });
    while (blocks.length >= 2) {
      const b = blocks.at(-1), a = blocks.at(-2);
      if (a.sum / a.weight >= b.sum / b.weight) break;
      a.to = b.to;
      a.sum += b.sum;
      a.weight += b.weight;
      blocks.pop();
    }
  }
  const out = Array(GRID.length).fill(null);
  for (const b of blocks) for (const o of observations)
    if (o.i >= b.from && o.i <= b.to) out[o.i] = b.sum / b.weight;
  let first = out.findIndex((x) => x != null);
  for (let i = 0; i < first; i++) out[i] = out[first];
  for (let i = first + 1; i < out.length; i++) {
    if (out[i] != null) continue;
    let j = i + 1;
    while (j < out.length && out[j] == null) j++;
    if (j >= out.length) { out[i] = out[i - 1]; continue; }
    const t = Math.log(GRID[i] / GRID[i - 1]) / Math.log(GRID[j] / GRID[i - 1]);
    out[i] = sigmoid(logit(out[i - 1]) + t * (logit(out[j]) - logit(out[i - 1])));
  }
  return out;
}

function enforceSlope(curve, slope, counts) {
  const out = [...curve];
  for (let i = 1; i < out.length; i++) {
    out[i] = Math.min(out[i], out[i - 1]);
    // The same-card estimate guards extrapolation. It must not overwrite bins
    // with enough completed auctions: doing so was badly miscalibrated on a
    // chronological holdout because sellers select prices by card quality.
    if (counts[i] >= 30) continue;
    const ceiling = sigmoid(logit(out[i - 1]) - slope * Math.log(GRID[i] / GRID[i - 1]));
    out[i] = clip(Math.min(out[i], ceiling), 1e-5, 1 - 1e-5);
  }
  return out;
}

function fitMatchedSlope(histogram) {
  // Conditional pair likelihood controls for card identity: among one sold and
  // one unsold listing of the same card variant, did the lower start sell?
  let beta = 1;
  if (!histogram?.size) return beta;
  for (let iteration = 0; iteration < 24; iteration++) {
    let gradient = -100 * (beta - 1), information = 100;
    for (const [bucket, weight] of histogram) {
      const d = bucket / 20;
      const p = sigmoid(beta * d);
      gradient += weight * d * (1 - p);
      information += weight * d * d * p * (1 - p);
    }
    const step = clip(gradient / information, -1, 1);
    beta = clip(beta + step, 0.5, 6);
    if (Math.abs(step) < 1e-4) break;
  }
  return beta;
}

function proceedsFor(group, i) {
  let values = [], radius = 0;
  while (radius < GRID.length) {
    values = [];
    for (let j = Math.max(0, i - radius); j <= Math.min(GRID.length - 1, i + radius); j++)
      values.push(...group.saleValues[j]);
    if (values.length >= 30 || radius >= GRID.length - 1) break;
    radius++;
  }
  if (!values.length) return { mean: GRID[i], variance: 0, effectiveN: 0 };
  values.sort((a, b) => a.v - b.v);
  const cap = Math.max(GRID[i], weightedQuantile(values, 0.99));
  let sw = 0, sw2 = 0, sx = 0, sx2 = 0;
  for (const x of values) {
    const v = Math.max(GRID[i], Math.min(cap, x.v));
    sw += x.w; sw2 += x.w * x.w; sx += x.w * v; sx2 += x.w * v * v;
  }
  const mean = sx / sw;
  return { mean, variance: Math.max(0, sx2 / sw - mean * mean), effectiveN: sw * sw / sw2 };
}

function build(db, maxEndAt, premiumCalibration = null) {
  const cutoff = maxEndAt == null ? '' : ' AND end_at <= $maxEndAt';
  const params = maxEndAt == null ? {} : { maxEndAt };
  const repeated = new Map();
  const repeatedSQL = `SELECT card_id, seller_id, rarity, is_shiny, listing_base_amount, COUNT(*) n
    FROM auctions NOT INDEXED WHERE ${TRAIN}${cutoff}
    GROUP BY card_id, seller_id, rarity, is_shiny, listing_base_amount HAVING COUNT(*) > 1`;
  for (const r of db.prepare(repeatedSQL).iterate(params)) repeated.set(repeatKey(r), r.n);

  const parents = new Map(), children = new Map();
  let dataTimestamp = 0;
  const rowsSQL = `SELECT card_id, seller_id, rarity, is_shiny, q_score, pageviews,
    listing_base_amount, status, final_price, end_at FROM auctions NOT INDEXED WHERE ${TRAIN}${cutoff}`;
  for (const r of db.prepare(rowsSQL).iterate(params)) {
    if (!Number.isFinite(r.listing_base_amount)) continue;
    const weight = 1 / Math.sqrt(repeated.get(repeatKey(r)) ?? 1);
    const sold = r.status === 'settled_sold' && Number.isFinite(r.final_price);
    const i = nearestIndex(r.listing_base_amount);
    const pk = keyOf(r.rarity, r.is_shiny), ck = featureKey(r.rarity, r.is_shiny, r.q_score, r.pageviews);
    for (const [map, key] of [[parents, pk], [children, ck]]) {
      let g = map.get(key);
      if (!g) { g = emptyGroup(); map.set(key, g); }
      g.n[i] += weight; g.total += weight;
      if (sold) { g.sold[i] += weight; g.soldTotal += weight; }
    }
    if (sold) parents.get(pk).saleValues[i].push({ v: r.final_price, w: weight });
    dataTimestamp = Math.max(dataTimestamp, r.end_at ?? 0);
  }

  const pairs = new Map();
  const orderedSQL = `SELECT card_id, seller_id, rarity, is_shiny, listing_base_amount,
    status FROM auctions NOT INDEXED WHERE ${TRAIN}${cutoff} ORDER BY card_id, rarity, is_shiny`;
  let last = null, variant = [];
  const flush = () => {
    if (!variant.length) return;
    const sold = variant.filter((x) => x.status === 'settled_sold');
    const unsold = variant.filter((x) => x.status === 'settled_unsold');
    if (sold.length && unsold.length) {
      const pk = keyOf(variant[0].rarity, variant[0].is_shiny);
      let h = pairs.get(pk);
      if (!h) { h = new Map(); pairs.set(pk, h); }
      for (const s of sold) for (const u of unsold) {
        const d = Math.log(u.listing_base_amount / s.listing_base_amount);
        const b = Math.round(d * 20);
        if (!b) continue;
        const w = 1 / Math.sqrt((repeated.get(repeatKey(s)) ?? 1) * (repeated.get(repeatKey(u)) ?? 1));
        h.set(b, (h.get(b) ?? 0) + w);
      }
    }
    variant = [];
  };
  for (const r of db.prepare(orderedSQL).iterate(params)) {
    const key = keyOf(r.rarity, r.is_shiny) + '|' + r.card_id;
    if (last !== null && key !== last) flush();
    last = key;
    variant.push(r);
  }
  flush();

  const slopes = new Map();
  for (const [pk, g] of parents) {
    const slope = fitMatchedSlope(pairs.get(pk));
    slopes.set(pk, slope);
    g.curve = enforceSlope(isotonicRates(g.n, g.sold), slope, g.n);
    g.proceeds = []; g.variance = []; g.proceedsN = [];
    for (let i = 0; i < GRID.length; i++) {
      const v = proceedsFor(g, i);
      g.proceeds.push(v.mean); g.variance.push(v.variance); g.proceedsN.push(v.effectiveN);
    }
    const allSales = g.saleValues.flat().sort((a, b) => a.v - b.v);
    g.p95Final = allSales.length ? weightedQuantile(allSales, 0.95) : 10;
    // Raw outcome values are only needed while building the robust summaries.
    g.saleValues = null;
  }
  for (const [ck, g] of children) {
    const pk = ck.split('|').slice(0, 2).join('|');
    const parent = parents.get(pk);
    const preliminary = g.n.map((n, i) => (g.sold[i] + 60 * parent.curve[i]) / (n + 60));
    g.curve = isotonicRates(g.n.map((n) => n + 60),
      preliminary.map((p, i) => p * (g.n[i] + 60)));
    g.saleValues = null;
  }
  if (!parents.size) throw new Error('market analyzer has no settled auction data');
  const state = { db, parents, children, slopes, repeated, dataTimestamp, maxEndAt,
    auctionColumns: new Set(db.prepare('PRAGMA table_info(auctions)').all().map((row) => row.name)) };
  state.premiumCalibrationReused = usablePremiumCalibration(premiumCalibration, dataTimestamp);
  state.premiumCalibration = state.premiumCalibrationReused ? premiumCalibration : calibratePremium(state);
  return state;
}

function exactRows(state, facts) {
  const cutoff = state.maxEndAt == null ? '' : ' AND end_at <= $maxEndAt';
  const query = `SELECT card_id, seller_id, rarity, is_shiny, listing_base_amount, status,
    final_price, end_at FROM auctions INDEXED BY auctions_card WHERE ${TRAIN}${cutoff}
    AND card_id = $cardId AND rarity = $rarity AND is_shiny = $shiny`;
  return state.db.prepare(query).all({ cardId: facts.cardId, rarity: facts.rarity,
    shiny: shinyCode(facts.shiny), ...(state.maxEndAt == null ? {} : { maxEndAt: state.maxEndAt }) });
}

// Eligibility and cautious resale values use every completed sale. A listing
// whose start was repriced still has a valid final sale price, even though it
// cannot train the relationship between starting ask and sale probability.
function exactSaleStats(state, facts) {
  if (!facts?.cardId || !facts?.rarity) throw new Error('stats requires cardId and rarity');
  const cutoff = state.maxEndAt == null ? '' : ' AND end_at <= $maxEndAt';
  const query = `SELECT final_price, end_at FROM auctions INDEXED BY auctions_card
    WHERE final = 1 AND status = 'settled_sold' AND final_price > 0
    AND card_id = $cardId AND rarity = $rarity AND is_shiny = $shiny${cutoff}
    ORDER BY final_price`;
  const rows = state.db.prepare(query).all({ cardId: facts.cardId, rarity: facts.rarity,
    shiny: shinyCode(facts.shiny), ...(state.maxEndAt == null ? {} : { maxEndAt: state.maxEndAt }) });
  const prices = rows.map((r) => r.final_price);
  const n = prices.length;
  return { soldCount: n, median: n ? (prices[Math.floor((n - 1) / 2)] + prices[Math.floor(n / 2)]) / 2 : null,
    // Nearest-rank lower quartile is intentionally conservative for small n.
    p25: n ? prices[Math.ceil(n * 0.25) - 1] : null,
    p75: n ? prices[Math.ceil(n * 0.75) - 1] : null,
    lastSoldAt: n ? rows.reduce((latest, r) => Math.max(latest, r.end_at ?? 0), 0) : null,
    dataTimestamp: state.dataTimestamp || null };
}

// A regularized exact-card logit fit learns whether this variant sold at its
// observed asks. Constraining the log-price slope positive keeps the resulting
// curve decreasing, including above the median where ordinary quote() stops.
function fitPremiumChance(rows, repeated, fallbackPrice) {
  const weighted = rows.map((r) => ({
    x: Math.log(r.listing_base_amount), y: r.status === 'settled_sold' ? 1 : 0,
    w: r.hybridWeight ?? 1 / Math.sqrt(repeated.get(repeatKey(r)) ?? 1),
  }));
  const total = weighted.reduce((n, r) => n + r.w, 0);
  const referencePrice = total
    ? Math.exp(weighted.reduce((n, r) => n + r.w * r.x, 0) / total)
    : Math.max(1, fallbackPrice);
  const logReference = Math.log(referencePrice);
  for (const r of weighted) r.x -= logReference;
  const alphaPrecision = 0.5, betaPrecision = 2;
  let alpha = 0, beta = 1, hAA = alphaPrecision, hAB = 0, hBB = betaPrecision;
  for (let iteration = 0; iteration < 30; iteration++) {
    let gA = -alphaPrecision * alpha, gB = -betaPrecision * (beta - 1);
    hAA = alphaPrecision; hAB = 0; hBB = betaPrecision;
    for (const r of weighted) {
      const p = sigmoid(alpha - beta * r.x), v = r.w * p * (1 - p);
      gA += r.w * (r.y - p);
      gB -= r.w * (r.y - p) * r.x;
      hAA += v; hAB -= v * r.x; hBB += v * r.x * r.x;
    }
    const determinant = hAA * hBB - hAB * hAB;
    const stepA = clip((gA * hBB - gB * hAB) / determinant, -1, 1);
    const stepB = clip((gB * hAA - gA * hAB) / determinant, -1, 1);
    alpha = clip(alpha + stepA, -8, 8);
    beta = clip(beta + stepB, 0.5, 6);
    if (Math.max(Math.abs(stepA), Math.abs(stepB)) < 1e-5) break;
  }
  // Recompute the information matrix at the constrained optimum.
  hAA = alphaPrecision; hAB = 0; hBB = betaPrecision;
  for (const r of weighted) {
    const p = sigmoid(alpha - beta * r.x), v = r.w * p * (1 - p);
    hAA += v; hAB -= v * r.x; hBB += v * r.x * r.x;
  }
  const determinant = hAA * hBB - hAB * hAB;
  return { alpha, beta, referencePrice, hAA, hAB, hBB, determinant,
    effectiveN: total };
}

function hybridDealQuote(state, facts, options = {}) {
  if (!facts?.cardId || !facts?.rarity) throw new Error('dealQuote requires cardId and rarity');
  const now = state.maxEndAt ?? options.now ?? Date.now();
  const optional = (column) => state.auctionColumns.has(column) ? column : `NULL AS ${column}`;
  // Every candidate lookup is an exact-card indexed query. New deal quotes do
  // not repeat model-wide calibration or browse unrelated cards.
  const rows = state.db.prepare(`SELECT id, card_id, seller_id, rarity, is_shiny,
    listing_base_amount, base_repriced_at, status, final_price, end_at,
    ${optional('winner_id')}, ${optional('created_at')} FROM auctions INDEXED BY auctions_card
    WHERE final = 1 AND status IN ('settled_sold', 'settled_unsold')
    AND card_id = $cardId AND rarity = $rarity AND is_shiny = $shiny
    AND end_at <= $now AND end_at >= $since`).all({ cardId: facts.cardId,
    rarity: facts.rarity, shiny: shinyCode(facts.shiny), now, since: now - 14 * 86_400_000 });
  return quoteHybridResale(rows, facts, { ...options, now }, {
    shift: state.premiumCalibration?.shift ?? 0, dataTimestamp: state.dataTimestamp });
}

/** Pure exact-history quote used by the worker and read-only strategy audits. */
export function quoteHybridResale(history, facts, options = {}, calibration = {}) {
  if (!facts?.cardId || !facts?.rarity) throw new Error('dealQuote requires cardId and rarity');
  const buy = { liquidMinSold: 8, minBuyers: 3, minSellers: 2, resaleAttempts: 6,
    repeatCorrelation: 0.5, horizonProbability: 0.8, probabilityRiskWeight: 0.35,
    premiumMinProfit: 75, premiumMinRoi: 0.15, liquidMinProfit: 15,
    liquidMinRoi: 0.25, liquidResaleAskRatio: 0.8, maxBuyRatio: 0.8,
    minProfitPerSlotHour: 0, slotOpportunityCoinsPerHour: 0,
    residualValueRatio: 0, minAttemptProbability: 0, ...options.buy };
  const now = options.now ?? Date.now();
  const durationMinutes = Number(options.durationMinutes ?? 60);
  const listingFee = Number(options.listingFee ?? 0);
  if (!Number.isFinite(now) || !Number.isFinite(durationMinutes) || durationMinutes <= 0
    || !Number.isFinite(listingFee) || listingFee < 0) throw new Error('invalid dealQuote economics');
  const requestedPrices = options.askPrices ?? [];
  if (!Array.isArray(requestedPrices) || requestedPrices.length > 32
    || requestedPrices.some((price) => !Number.isSafeInteger(price) || price < 1))
    throw new Error('askPrices requires up to 32 positive integer prices');
  const rows = history.filter((row) => row.card_id === facts.cardId && row.rarity === facts.rarity
    && shinyCode(row.is_shiny) === shinyCode(facts.shiny)
    && ['settled_sold', 'settled_unsold'].includes(row.status)
    && row.end_at <= now && row.end_at >= now - 14 * 86_400_000).map((row) => ({ ...row }));
  const ids = new Set(rows.map((row) => row.id));
  let ownAdded = 0;
  for (const own of options.ownOutcomes ?? []) {
    if (own.cardId !== facts.cardId || own.rarity !== facts.rarity || shinyCode(own.shiny) !== shinyCode(facts.shiny)
      || !['settled_sold', 'settled_unsold'].includes(own.status)) continue;
    const id = own.auctionId ?? own.id;
    const endAt = Number(own.endAt ?? own.settledAt);
    if (!id || ids.has(id) || !Number.isFinite(endAt) || endAt > now || endAt < now - 14 * 86_400_000) continue;
    ids.add(id); ownAdded++;
    rows.push({ id, card_id: facts.cardId, seller_id: own.sellerId ?? '__own__', rarity: facts.rarity,
      is_shiny: shinyCode(facts.shiny), listing_base_amount: Number(own.price), base_repriced_at: null,
      status: own.status, final_price: Number(own.finalPrice), end_at: endAt,
      winner_id: own.winnerId ?? null, created_at: Number(own.createdAt), ownOutcome: true });
  }
  const repeatCounts = new Map();
  for (const row of rows) repeatCounts.set(repeatKey(row), (repeatCounts.get(repeatKey(row)) ?? 0) + 1);
  for (const row of rows) {
    // Three-day half-life reacts to demand changes without discarding a week's
    // history abruptly. A seller repeating the same ask supplies less evidence.
    row.recencyWeight = 2 ** (-Math.max(0, now - row.end_at) / (72 * 3_600_000));
    const duration = row.created_at > 0 && row.end_at > row.created_at
      ? (row.end_at - row.created_at) / 60_000 : null;
    row.durationWeight = duration == null ? 0.25
      : duration >= durationMinutes / 2 && duration <= durationMinutes * 2
        ? Math.exp(-2 * Math.abs(Math.log(duration / durationMinutes))) : 0;
    row.hybridWeight = row.recencyWeight * row.durationWeight / Math.sqrt(repeatCounts.get(repeatKey(row)));
  }
  const controlledIds = new Set(options.controlledUserIds ?? []);
  const sales = rows.filter((row) => row.status === 'settled_sold' && row.final_price > 0
    && !row.ownOutcome && !controlledIds.has(row.seller_id) && !controlledIds.has(row.winner_id));
  const buyers = new Set(sales.map((row) => row.winner_id).filter(Boolean)).size;
  const sellers = new Set(sales.map((row) => row.seller_id).filter((id) => id && id !== '__own__')).size;
  const prices = sales.map((row) => ({ v: row.final_price, w: row.recencyWeight })).sort((a, b) => a.v - b.v);
  const median = weightedQuantile(prices, 0.5), p25 = weightedQuantile(prices, 0.25);
  const stats = { soldCount: sales.length, median, p25, p75: weightedQuantile(prices, 0.75), buyers, sellers,
    lastSoldAt: sales.length ? Math.max(...sales.map((row) => row.end_at)) : null,
    dataTimestamp: calibration.dataTimestamp || null };
  const threshold = typeof options.premiumThreshold === 'number'
    ? { minMedian: options.premiumThreshold } : options.premiumThreshold ?? {};
  const premium = stats.soldCount >= Number(threshold.minSold ?? buy.minSold ?? 4)
    && median > Number(threshold.minMedian ?? 500);
  const lane = premium ? 'premium' : 'liquid';
  const requiredSales = premium ? Number(threshold.minSold ?? buy.minSold ?? 4) : Number(buy.liquidMinSold);
  const base = { ...stats, stats, lane, curve: [], pricingVersion: 'hybrid-v1', estimated: true };
  if (stats.soldCount < requiredSales) return { ...base, reason: 'insufficient recent exact-variant sales' };
  if (buyers < buy.minBuyers || sellers < buy.minSellers)
    return { ...base, reason: 'insufficient independent buyers or sellers' };
  const training = rows.filter((row) => row.base_repriced_at == null
    && row.listing_base_amount >= 1 && row.hybridWeight > 0);
  const durationMatched = training.filter((row) => row.durationWeight > 0.25).length;
  if (durationMatched < 2) return { ...base, reason: 'insufficient evidence for the planned listing duration' };
  const chance = fitPremiumChance(training, repeatCounts, median);
  const riskWeight = clip(Number(buy.probabilityRiskWeight), 0, 1);
  const attempts = clip(Math.floor(Number(buy.resaleAttempts)), 1, 24);
  const correlation = clip(Number(buy.repeatCorrelation), 0, 1);
  const minProfit = Number(premium ? buy.premiumMinProfit : buy.liquidMinProfit);
  const minRoi = Number(premium ? buy.premiumMinRoi : buy.liquidMinRoi);
  const openingAskRatio = premium ? 1 : Number(buy.liquidResaleAskRatio);
  const askCap = Math.max(1, Math.floor(Math.min(p25, median * 0.85) * openingAskRatio));
  const candidatePrices = new Set([askCap]);
  for (const ratio of [0.45, 0.6, 0.75, 0.9]) candidatePrices.add(Math.max(1, Math.floor(askCap * ratio)));
  for (const row of training) if (row.listing_base_amount <= askCap) candidatePrices.add(row.listing_base_amount);
  // Keep the optimization small even for heavily traded cards.
  const supported = [...candidatePrices].sort((a, b) => a - b);
  const grid = supported.filter((_, i) => supported.length <= 16 || i === supported.length - 1
    || i % Math.ceil(supported.length / 15) === 0);
  const busy = options.slots?.free === 0 || Number(options.queueDepth ?? 0) > 0;
  const queuePressure = busy ? Math.min(1, Number(options.queueDepth ?? 0) / Math.max(1, Number(options.slots?.max ?? 5))) : 0;
  const cutoff = Math.max(0, Number(options.cutoff ?? 0));
  const curve = [...new Set([...grid, ...requestedPrices])].map((price) => {
    const x = Math.log(price / chance.referencePrice);
    // The broad premium holdout supplies only a downward calibration offset;
    // independent exact history determines this card's curve and uncertainty.
    const eta = chance.alpha - chance.beta * x - Math.max(0, calibration.shift ?? 0);
    const se = Math.sqrt(Math.max(0, (chance.hBB + 2 * x * chance.hAB + x * x * chance.hAA) / chance.determinant));
    const p = sigmoid(eta), pLow = sigmoid(eta - 1.28155 * se), pHigh = sigmoid(eta + 1.28155 * se);
    const riskAdjustedP = (1 - riskWeight) * p + riskWeight * pLow;
    const horizon = resaleHorizon(riskAdjustedP, attempts, correlation);
    const expectedFees = listingFee * horizon.expectedAttempts;
    const expectedSlotHours = horizon.expectedAttempts * durationMinutes / 60;
    const slotCost = Math.max(cutoff * 60 / durationMinutes, Number(buy.slotOpportunityCoinsPerHour))
      * expectedSlotHours * (1 + queuePressure);
    // Step-downs can use the acquisition margin as a floor. Initially include
    // their full conservative decline in proceeds, then publish that schedule
    // with the quote so buying never assumes a richer exit than selling uses.
    const scheduledFloor = Math.max(1, Math.floor(price * 0.92 ** (attempts - 1)));
    // Unsold stock is not realized cash. The selective policy assigns it no
    // resale credit when deciding whether to commit coins to a new purchase.
    const residualValue = Math.min(scheduledFloor, Math.floor(p25 * Number(buy.residualValueRatio)));
    const stressedValue = horizon.saleProbabilities.reduce((sum, chance, i) =>
      sum + chance * Math.max(1, Math.floor(price * 0.92 ** i)), 0)
      + horizon.survival * residualValue;
    const netValue = stressedValue - expectedFees - slotCost;
    const requiredProfit = Math.max(minProfit, Number(buy.minProfitPerSlotHour) * expectedSlotHours);
    const maxBid = Math.floor(Math.min(netValue - requiredProfit, netValue / (1 + minRoi), price * Number(buy.maxBuyRatio)));
    return { price, p, pLow, pHigh, riskAdjustedP, horizonP: horizon.probability,
      expectedAttempts: horizon.expectedAttempts, expectedSlotHours, requiredProfit, expectedFees, slotCost, stressedValue,
      residualValue, maxBid, meanProceeds: price, mu: netValue, L: netValue, U: netValue,
      scheduledFloor, supportedAsk: price <= askCap };
  });
  const evidence = { source: 'exact-card-hybrid', rawSold: training.filter((row) => row.status === 'settled_sold').length,
    rawUnsold: training.filter((row) => row.status === 'settled_unsold').length,
    effectiveN: chance.effectiveN, durationMatched, ownOutcomesAdded: ownAdded,
    ownOutcomesObserved: training.filter((row) => ids.has(row.id) && row.ownOutcome).length,
    independentBuyers: buyers, independentSellers: sellers, repeatCorrelation: correlation,
    durationMinutes, historyDays: 14, recencyHalfLifeHours: 72,
    calibrationLogOdds: Math.max(0, calibration.shift ?? 0) };
  const eligible = curve.filter((point) => point.supportedAsk && point.maxBid >= 1
    && point.horizonP >= Number(buy.horizonProbability)
    && point.riskAdjustedP >= Number(buy.minAttemptProbability));
  const chosen = eligible.sort((a, b) => b.maxBid - a.maxBid || b.horizonP - a.horizonP)[0];
  if (!chosen) return { ...base, curve, evidence, reason: curve.some((point) => point.horizonP >= Number(buy.horizonProbability)
    && point.riskAdjustedP >= Number(buy.minAttemptProbability))
    ? 'finite-horizon proceeds do not cover the required margin' : 'estimated retry-horizon sale probability is too low' };
  return { ...base, curve, evidence, chosen, safeExit: chosen.price, exitP: chosen.p,
    horizonP: chosen.horizonP, attempts, expectedFees: chosen.expectedFees, slotCost: chosen.slotCost,
    stressedValue: chosen.stressedValue, residualValue: chosen.residualValue,
    expectedSlotHours: chosen.expectedSlotHours, expectedAttempts: chosen.expectedAttempts,
    maxBid: chosen.maxBid, minProfit, minRoi,
    resalePlan: { ask: chosen.price, openingAskRatio, floor: chosen.scheduledFloor, attemptLimit: attempts,
      durationMinutes, stepDownPct: 0.08, estimatedHorizonP: chosen.horizonP,
      estimatedAttemptP: chosen.p, repeatCorrelation: correlation, minProfit, minRoi,
      pricingVersion: 'hybrid-v1' } };
}

function premiumQuoteAtPrices(state, facts, prices, options = {}) {
  if (!facts?.cardId || !facts?.rarity) throw new Error('quoteAtPrices requires cardId and rarity');
  if (!Array.isArray(prices) || prices.length > 4096 ||
      prices.some((price) => !Number.isSafeInteger(price) || price < 1))
    throw new Error('quoteAtPrices requires up to 4096 positive integer prices');
  const opts = { recycleValue: 1, listingFee: 0, targetProbability: 0.25,
    outcomePenalty: 0.25, modelLowerPenalty: 0.5, modelUpperBonus: 1.28, ...options };
  for (const name of ['recycleValue', 'listingFee', 'targetProbability', 'outcomePenalty',
    'modelLowerPenalty', 'modelUpperBonus'])
    if (!Number.isFinite(Number(opts[name]))) throw new Error(`invalid ${name}`);
  if (opts.recycleValue < 0 || opts.listingFee < 0 || opts.targetProbability < 0 || opts.targetProbability > 1)
    throw new Error('invalid quote economics');

  const stats = exactSaleStats(state, facts);
  const rows = exactRows(state, facts);
  const sold = rows.filter((r) => r.status === 'settled_sold');
  const chance = fitPremiumChance(rows, state.repeated, stats.median ?? 1);
  const upliftSamples = sold.filter((r) => Number.isFinite(r.final_price) && r.final_price > 0)
    .map((r) => ({ v: Math.max(0, r.final_price - r.listing_base_amount),
      w: 1 / Math.sqrt(state.repeated.get(repeatKey(r)) ?? 1) }))
    .sort((a, b) => a.v - b.v);
  const medianUplift = weightedQuantile(upliftSamples, 0.5) ?? 0;
  const rawSold = sold.length, rawUnsold = rows.length - rawSold;
  const evidence = { rawSold, rawUnsold, effectiveN: chance.effectiveN,
    soldCount: stats.soldCount, observedSaleMedian: stats.median, p25: stats.p25,
    p75: stats.p75, lastSoldAt: stats.lastSoldAt, medianUplift,
    referencePrice: chance.referencePrice, logPriceSlope: chance.beta,
    calibrationLogOdds: state.premiumCalibration?.shift ?? 0,
    source: 'exact-card-premium' };
  if (!stats.soldCount) return { curve: [], chosen: null, evidence,
    targetMet: false, dataTimestamp: stats.dataTimestamp };
  const curve = prices.map((price) => {
    const x = Math.log(price / chance.referencePrice);
    const eta = chance.alpha - chance.beta * x - (state.premiumCalibration?.shift ?? 0);
    // With no completed non-repriced listing, there is no evidence for any
    // one-hour sale chance. Premium eligibility can still use repriced sales.
    const p = rows.length ? sigmoid(eta) : 0;
    const logitVariance = Math.max(0,
      (chance.hBB + 2 * x * chance.hAB + x * x * chance.hAA) / chance.determinant);
    const se = Math.sqrt(logitVariance);
    const pLow = rows.length ? sigmoid(eta - 1.28155 * se) : 0;
    const pHigh = rows.length ? sigmoid(eta + 1.28155 * se) : 0;
    // A high ask is at least its own proceeds if it sells. Only observed bid-up
    // supports more than that; p75 prevents a few exceptional auctions from
    // predicting a windfall on every premium listing.
    const meanProceeds = Math.max(price, Math.min(price + medianUplift, stats.p75));
    const weights = upliftSamples.reduce((n, s) => n + s.w, 0);
    const priceVariance = weights ? upliftSamples.reduce((sum, s) => {
      const value = Math.max(price, Math.min(price + s.v, stats.p75));
      return sum + s.w * (value - meanProceeds) ** 2;
    }, 0) / weights : 0;
    const sigmaOutcome = Math.sqrt(p * priceVariance + p * (1 - p) * (meanProceeds - opts.recycleValue) ** 2);
    const pVariance = ((pHigh - pLow) / 2.5631) ** 2;
    const proceedsSE = Math.sqrt(priceVariance + (0.5 * stats.median) ** 2) / Math.sqrt(Math.max(1, weights));
    const sigmaModel = Math.sqrt((meanProceeds - opts.recycleValue) ** 2 * pVariance + p * p * proceedsSE ** 2);
    const mu = p * (meanProceeds - opts.recycleValue) - opts.listingFee;
    return { price, p, pLow, pHigh, meanProceeds, priceVariance,
      sigmaOutcome, sigmaModel, mu, L: mu - opts.outcomePenalty * sigmaOutcome - opts.modelLowerPenalty * sigmaModel,
      U: mu - opts.outcomePenalty * sigmaOutcome + opts.modelUpperBonus * sigmaModel,
      expectedGain: mu };
  });
  const qualifying = curve.filter((point) => point.p >= opts.targetProbability);
  const chosen = [...(qualifying.length ? qualifying : curve)]
    .sort((a, b) => qualifying.length ? b.price - a.price : a.price - b.price)[0] ?? null;
  if (chosen) chosen.tier = qualifying.length ? 'target' : 'fallback';
  return { curve, chosen, evidence, targetMet: qualifying.length > 0,
    dataTimestamp: stats.dataTimestamp };
}

function makePosterior(curve, rows, repeated) {
  const nodes = [];
  for (let j = -40; j <= 40; j++) {
    const delta = j / 10;
    let logWeight = -delta * delta / 2;
    for (const r of rows) {
      const p0 = interpolate(curve, r.listing_base_amount);
      const p = clip(sigmoid(logit(p0) + delta), 1e-9, 1 - 1e-9);
      const w = 1 / Math.sqrt(repeated.get(repeatKey(r)) ?? 1);
      logWeight += w * (r.status === 'settled_sold' ? Math.log(p) : Math.log(1 - p));
    }
    nodes.push({ delta, logWeight });
  }
  const max = Math.max(...nodes.map((x) => x.logWeight));
  const sum = nodes.reduce((n, x) => n + Math.exp(x.logWeight - max), 0);
  for (const x of nodes) x.w = Math.exp(x.logWeight - max) / sum;
  return nodes;
}

function posteriorProbability(peerP, nodes, peerN) {
  const base = logit(peerP);
  const points = nodes.map((x) => ({ p: sigmoid(base + x.delta), w: x.w }));
  const p = points.reduce((sum, x) => sum + x.p * x.w, 0);
  const variance = points.reduce((sum, x) => sum + (x.p - p) ** 2 * x.w, 0);
  const pLow = weightedQuantile(points.map((x) => ({ v: x.p, w: x.w })), 0.10);
  const pHigh = weightedQuantile(points.map((x) => ({ v: x.p, w: x.w })), 0.90);
  const peerSE = Math.sqrt(p * (1 - p) / Math.max(20, peerN));
  return { p, pLow: clip(pLow - 1.28 * peerSE, 0, 1),
    pHigh: clip(pHigh + 1.28 * peerSE, 0, 1), variance: variance + peerSE ** 2 };
}

// Once a card has a recorded sale, its quote uses only auctions of that exact
// card variant. A flat prior on sale chance and a fixed log-price slope avoid
// borrowing another card's demand or bid-up value when history is thin.
function exactOnlyQuote(state, facts, opts, rows, pricesOverride) {
  const weight = (r) => 1 / Math.sqrt(state.repeated.get(repeatKey(r)) ?? 1);
  const sold = rows.filter((r) => r.status === 'settled_sold' && Number.isFinite(r.final_price));
  const rawSold = sold.length, rawUnsold = rows.length - rawSold;
  const effectiveN = rows.reduce((sum, r) => sum + weight(r), 0);
  const effectiveSoldN = sold.reduce((sum, r) => sum + weight(r), 0);
  const independentAuctionGroups = new Set(rows.map(repeatKey)).size;
  const independentSoldGroups = new Set(sold.map(repeatKey)).size;
  const cardLastSettledAt = Math.max(...rows.map((r) => r.end_at ?? 0));
  const referencePrice = Math.exp(rows.reduce((sum, r) => sum + weight(r) * Math.log(r.listing_base_amount), 0) / effectiveN);
  const priceLogs = rows.map((r) => Math.log(r.listing_base_amount));
  const logMean = priceLogs.reduce((sum, x) => sum + x, 0) / priceLogs.length;
  const startPriceVariance = priceLogs.length > 1
    ? priceLogs.reduce((sum, x) => sum + (x - logMean) ** 2, 0) / (priceLogs.length - 1) : 0;
  const finals = sold.map((r) => ({ v: r.final_price, w: weight(r) })).sort((a, b) => a.v - b.v);
  const uplifts = sold.map((r) => ({ v: Math.max(0, r.final_price - r.listing_base_amount), w: weight(r) }))
    .sort((a, b) => a.v - b.v);
  const observedSaleMedian = weightedQuantile(finals, 0.5);
  const medianUplift = weightedQuantile(uplifts, 0.5);
  const maxSuggestedStart = Math.min(GRID.at(-1), Math.max(1, Math.floor(observedSaleMedian * 0.8)));
  const rawMean = sold.reduce((sum, r) => sum + r.final_price, 0) / rawSold;
  const rawSoldPriceVariance = rawSold > 1
    ? sold.reduce((sum, r) => sum + (r.final_price - rawMean) ** 2, 0) / (rawSold - 1) : null;

  const nodes = Array.from({ length: 201 }, (_, i) => {
    const p0 = (i + 0.5) / 201;
    let logWeight = 0;
    for (const r of rows) {
      const odds = p0 / (1 - p0) * referencePrice / r.listing_base_amount;
      const p = clip(odds / (1 + odds), 1e-9, 1 - 1e-9);
      logWeight += weight(r) * (r.status === 'settled_sold' ? Math.log(p) : Math.log(1 - p));
    }
    return { p0, logWeight };
  });
  const peak = Math.max(...nodes.map((x) => x.logWeight));
  const normalizer = nodes.reduce((sum, x) => sum + Math.exp(x.logWeight - peak), 0);
  for (const node of nodes) node.w = Math.exp(node.logWeight - peak) / normalizer;

  const prices = pricesOverride ?? [...new Set([
    ...GRID.filter((price) => price <= maxSuggestedStart), maxSuggestedStart,
    ...rows.map((r) => r.listing_base_amount).filter((price) => price <= maxSuggestedStart),
  ])].sort((a, b) => a - b);
  const curve = prices.map((price) => {
    const probabilities = nodes.map((node) => {
      const odds = node.p0 / (1 - node.p0) * referencePrice / price;
      return { v: odds / (1 + odds), w: node.w };
    });
    const p = probabilities.reduce((sum, x) => sum + x.v * x.w, 0);
    const probabilityVariance = probabilities.reduce((sum, x) => sum + (x.v - p) ** 2 * x.w, 0);
    const pLow = weightedQuantile(probabilities, 0.1);
    const pHigh = weightedQuantile(probabilities, 0.9);
    const meanProceeds = Math.max(price, Math.min(observedSaleMedian, price + medianUplift));
    const priceVariance = sold.reduce((sum, r) => {
      const proceeds = Math.max(price, Math.min(observedSaleMedian,
        price + Math.max(0, r.final_price - r.listing_base_amount)));
      return sum + weight(r) * (proceeds - meanProceeds) ** 2;
    }, 0) / effectiveSoldN;
    const sigmaOutcome = Math.sqrt(p * priceVariance + p * (1 - p) * (meanProceeds - opts.recycleValue) ** 2);
    const proceedsSE = Math.sqrt(priceVariance + (0.5 * observedSaleMedian) ** 2) / Math.sqrt(effectiveSoldN);
    const sigmaModel = Math.sqrt((meanProceeds - opts.recycleValue) ** 2 * probabilityVariance + p * p * proceedsSE ** 2);
    const mu = p * (meanProceeds - opts.recycleValue) - opts.listingFee;
    const L = mu - opts.outcomePenalty * sigmaOutcome - opts.modelLowerPenalty * sigmaModel;
    const U = mu - opts.outcomePenalty * sigmaOutcome + opts.modelUpperBonus * sigmaModel;
    return { price, p, pLow, pHigh, meanProceeds, priceVariance,
      sigmaOutcome, sigmaModel, mu, L, U, expectedGain: mu };
  });
  const profitable = curve.filter((x) => x.mu > 0);
  const target = profitable.filter((x) => x.p >= opts.targetProbability);
  const chosen = [...(target.length ? target : profitable)]
    .sort((a, b) => b.L - a.L || b.p - a.p || a.price - b.price)[0] ?? null;
  if (chosen) chosen.tier = target.length ? 'target' : 'fallback';
  return { curve, chosen, evidence: { rawSold, rawUnsold, effectiveN,
    independentAuctionGroups, independentSoldGroups, effectiveSoldN,
    peerN: 0, parentN: 0, peerSold: 0, peerPriceVariance: null,
    priceVariance: chosen?.priceVariance ?? null, rawSoldPriceVariance,
    observedSaleMedian, medianUplift, maxSuggestedStart,
    startPriceVariance, cardLastSettledAt, source: 'exact-card-only' },
    targetMet: Boolean(chosen && chosen.p >= opts.targetProbability),
    dataTimestamp: state.dataTimestamp || null };
}

function coreQuote(state, facts, options = {}, pricesOverride = null) {
  if (!facts?.cardId || !facts?.rarity) throw new Error('quote requires cardId and rarity');
  const opts = { recycleValue: 1, listingFee: 0, targetProbability: 0.8,
    outcomePenalty: 0.25, modelLowerPenalty: 0.5, modelUpperBonus: 1.28, ...options };
  for (const name of ['recycleValue', 'listingFee', 'targetProbability', 'outcomePenalty',
    'modelLowerPenalty', 'modelUpperBonus'])
    if (!Number.isFinite(Number(opts[name]))) throw new Error(`invalid ${name}`);
  if (opts.recycleValue < 0 || opts.listingFee < 0 || opts.targetProbability < 0 || opts.targetProbability > 1)
    throw new Error('invalid quote economics');
  const rows = exactRows(state, facts);
  const soldCount = rows.filter((r) => r.status === 'settled_sold' && Number.isFinite(r.final_price)).length;
  if (soldCount) return exactOnlyQuote(state, facts, opts, rows, pricesOverride);
  if (!['UR', 'L'].includes(facts.rarity)) return { curve: [], chosen: null,
    evidence: { rawSold: 0, rawUnsold: rows.length,
      effectiveN: rows.reduce((sum, r) => sum + 1 / Math.sqrt(state.repeated.get(repeatKey(r)) ?? 1), 0),
      independentAuctionGroups: new Set(rows.map(repeatKey)).size,
      cardLastSettledAt: rows.length ? Math.max(...rows.map((r) => r.end_at ?? 0)) : null,
      source: 'zero-sales-recycle' }, targetMet: false, dataTimestamp: state.dataTimestamp || null };
  const pk = keyOf(facts.rarity, facts.shiny);
  const parent = state.parents.get(pk) ?? state.parents.get(keyOf(facts.rarity, false));
  if (!parent) return { curve: [], chosen: null, evidence: { rawSold: 0, rawUnsold: 0,
    effectiveN: 0, peerN: 0, priceVariance: 0, cardLastSettledAt: null },
    targetMet: false, dataTimestamp: state.dataTimestamp || null };
  const child = state.children.get(featureKey(facts.rarity, facts.shiny, facts.qScore, facts.pageviews));
  const peerCurve = child?.curve ?? parent.curve;
  const posterior = makePosterior(peerCurve, rows, state.repeated);
  const rawSold = rows.filter((r) => r.status === 'settled_sold').length;
  const rawUnsold = rows.length - rawSold;
  const effectiveN = rows.reduce((n, r) => n + 1 / Math.sqrt(state.repeated.get(repeatKey(r)) ?? 1), 0);
  const independentAuctionGroups = new Set(rows.map(repeatKey)).size;
  const logPrices = rows.map((r) => Math.log(r.listing_base_amount));
  const logMean = logPrices.reduce((n, x) => n + x, 0) / (logPrices.length || 1);
  const startPriceVariance = logPrices.length > 1 ?
    logPrices.reduce((n, x) => n + (x - logMean) ** 2, 0) / (logPrices.length - 1) : 0;
  const cardLastSettledAt = rows.length ? Math.max(...rows.map((r) => r.end_at ?? 0)) : null;

  // Own sold outcomes adjust the peer bid-up expectation, with ten synthetic
  // peer sales of shrinkage. A single spectacular bid cannot set the card price.
  let ratioSum = 0, ratioN = 0, ratioWeightSquared = 0;
  const ratioSamples = [], rawSoldPrices = [], weightedSoldPrices = [], independentSoldGroups = new Set();
  for (const r of rows) {
    if (r.status !== 'settled_sold' || !Number.isFinite(r.final_price)) continue;
    rawSoldPrices.push(r.final_price);
    independentSoldGroups.add(repeatKey(r));
    const i = nearestIndex(r.listing_base_amount);
    const peerMean = Math.max(1, parent.proceeds[i]);
    const peerCap = peerMean + 3 * Math.sqrt(parent.variance[i]);
    const ratio = clip(Math.min(r.final_price, peerCap) / peerMean, 0.2, 5);
    const w = 1 / Math.sqrt(state.repeated.get(repeatKey(r)) ?? 1);
    weightedSoldPrices.push({ v: r.final_price, w });
    ratioSamples.push({ ratio, w });
    ratioSum += w * ratio; ratioN += w; ratioWeightSquared += w * w;
  }
  const cardRatio = (10 + ratioSum) / (10 + ratioN);
  const exactRatioMean = ratioN ? ratioSum / ratioN : 1;
  const ratioVarianceDenominator = ratioN - ratioWeightSquared / (ratioN || 1);
  const exactRelativeVariance = ratioVarianceDenominator > 0
    ? ratioSamples.reduce((sum, x) => sum + x.w * (x.ratio - exactRatioMean) ** 2, 0) / ratioVarianceDenominator
    : null;
  // At least three distinct seller/start groups are needed before a card's
  // price spread can challenge the peer estimate. Eight peer-equivalent sales
  // keep a small exact history from collapsing variance to zero.
  const spreadEvidence = independentSoldGroups.size >= 3 && exactRelativeVariance != null
    ? Math.max(0, ratioN - 1) : 0;
  const rawPriceMean = rawSoldPrices.reduce((sum, x) => sum + x, 0) / (rawSoldPrices.length || 1);
  const rawSoldPriceVariance = rawSoldPrices.length > 1
    ? rawSoldPrices.reduce((sum, x) => sum + (x - rawPriceMean) ** 2, 0) / (rawSoldPrices.length - 1)
    : null;
  weightedSoldPrices.sort((a, b) => a.v - b.v);
  const observedSaleMedian = weightedQuantile(weightedSoldPrices, 0.5);
  const maxSuggestedStart = observedSaleMedian == null ? null : Math.max(1, Math.floor(observedSaleMedian * 0.8));
  const maxExact = rows.filter((r) => r.status === 'settled_sold')
    .reduce((n, r) => Math.max(n, r.final_price ?? 0), 0);
  const marketUpperPrice = clip(Math.max(10, parent.p95Final * 1.5, Math.min(maxExact, parent.p95Final * 3)), 10, GRID.at(-1));
  const upperPrice = Math.floor(maxSuggestedStart == null ? marketUpperPrice : Math.min(marketUpperPrice, maxSuggestedStart));
  const prices = pricesOverride ?? [...new Set([
    ...GRID.filter((x) => x <= upperPrice),
    upperPrice,
    ...rows.map((r) => r.listing_base_amount).filter((x) => x <= upperPrice),
  ])].sort((a, b) => a - b);
  const curve = prices.map((price) => {
    const i = nearestIndex(price);
    const peerN = (child?.n[i] ?? 0) + 60;
    const probability = posteriorProbability(interpolate(peerCurve, price), posterior, peerN);
    const p = probability.p;
    const meanProceeds = Math.max(price,
      Math.min(interpolate(parent.proceeds, price) * cardRatio, observedSaleMedian ?? Infinity));
    const peerMean = Math.max(1, interpolate(parent.proceeds, price));
    const peerVariance = Math.max(0, interpolate(parent.variance, price));
    const peerRelativeVariance = peerVariance / peerMean ** 2 * cardRatio ** 2;
    const relativeVariance = (8 * peerRelativeVariance + spreadEvidence * (exactRelativeVariance ?? 0))
      / (8 + spreadEvidence);
    const conditionalVariance = peerMean ** 2 * relativeVariance;
    const sigmaOutcome = Math.sqrt(p * conditionalVariance + p * (1 - p) * (meanProceeds - opts.recycleValue) ** 2);
    const proceedsN = Math.max(1, interpolate(parent.proceedsN, price));
    const sigmaMean = Math.sqrt(conditionalVariance / (proceedsN + ratioN));
    const sigmaModel = Math.sqrt((meanProceeds - opts.recycleValue) ** 2 * probability.variance + p * p * sigmaMean ** 2);
    const mu = p * (meanProceeds - opts.recycleValue) - opts.listingFee;
    const L = mu - opts.outcomePenalty * sigmaOutcome - opts.modelLowerPenalty * sigmaModel;
    const U = mu - opts.outcomePenalty * sigmaOutcome + opts.modelUpperBonus * sigmaModel;
    return { price, p, pLow: probability.pLow, pHigh: probability.pHigh,
      meanProceeds, priceVariance: conditionalVariance, sigmaOutcome, sigmaModel,
      mu, L, U, expectedGain: mu };
  });
  const profitable = curve.filter((x) => x.mu > 0);
  const target = profitable.filter((x) => x.p >= opts.targetProbability);
  const rank = (a, b) => b.L - a.L || b.p - a.p || a.price - b.price;
  const chosen = [...(target.length ? target : profitable)].sort(rank)[0] ?? null;
  if (chosen) chosen.tier = target.length ? 'target' : 'fallback';
  const priceVariance = chosen?.priceVariance ?? null;
  const peerPriceVariance = chosen ? Math.max(0, interpolate(parent.variance, chosen.price)) : null;
  return { curve, chosen, evidence: { rawSold, rawUnsold, effectiveN, independentAuctionGroups,
    peerN: child?.total ?? parent.total, priceVariance, peerPriceVariance,
    rawSoldPriceVariance, observedSaleMedian, maxSuggestedStart,
    effectiveSoldN: ratioN, independentSoldGroups: independentSoldGroups.size,
    startPriceVariance, cardLastSettledAt,
    parentN: parent.total, peerSold: child?.soldTotal ?? parent.soldTotal },
    targetMet: Boolean(chosen && chosen.p >= opts.targetProbability),
    dataTimestamp: state.dataTimestamp || null };
}

function holdout(state, limit = 5000) {
  if (state.maxEndAt == null) throw new Error('holdout requires a model built with maxEndAt');
  const sql = `SELECT card_id, rarity, is_shiny, q_score, pageviews,
    listing_base_amount, status FROM auctions WHERE ${TRAIN} AND end_at > $cutoff
    ORDER BY end_at LIMIT $limit`;
  let n = 0, brier = 0, logLoss = 0;
  const bins = Array.from({ length: 10 }, (_, i) => ({ bin: i, n: 0, sold: 0, predicted: 0 }));
  for (const r of state.db.prepare(sql).iterate({ cutoff: state.maxEndAt, limit: clip(Math.floor(limit), 1, 50000) })) {
    const quote = coreQuote(state, { cardId: r.card_id, rarity: r.rarity,
      shiny: r.is_shiny, qScore: r.q_score, pageviews: r.pageviews }, {}, [r.listing_base_amount]);
    const p = quote.curve[0]?.p;
    if (p == null) continue;
    const y = r.status === 'settled_sold' ? 1 : 0;
    n++; brier += (p - y) ** 2;
    logLoss += -(y * Math.log(clip(p, 1e-9, 1)) + (1 - y) * Math.log(clip(1 - p, 1e-9, 1)));
    const bin = bins[Math.min(9, Math.floor(p * 10))];
    bin.n++; bin.sold += y; bin.predicted += p;
  }
  return { n, brier: n ? brier / n : null, logLoss: n ? logLoss / n : null,
    bins: bins.map((b) => ({ bin: b.bin, n: b.n,
      observed: b.n ? b.sold / b.n : null, predicted: b.n ? b.predicted / b.n : null })) };
}

function premiumHoldout(state, { limit = 5000, minSales = 4, medianThreshold = 500,
  sampleModulo = 1, startAfter = null, endBefore = null, includeScores = false,
  calibrationShift = state.premiumCalibration?.shift ?? 0 } = {}) {
  if (state.maxEndAt == null) throw new Error('premium holdout requires a model built with maxEndAt');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50000 ||
      !Number.isSafeInteger(minSales) || minSales < 1 ||
      !Number.isSafeInteger(sampleModulo) || sampleModulo < 1 || sampleModulo > 10000 ||
      (startAfter != null && !Number.isFinite(startAfter)) ||
      (endBefore != null && !Number.isFinite(endBefore)) ||
      !Number.isFinite(calibrationShift) || calibrationShift < 0 ||
      !Number.isFinite(medianThreshold) || medianThreshold < 0)
    throw new Error('invalid premium holdout options');
  const sql = `SELECT id, card_id, rarity, is_shiny, listing_base_amount, status, end_at
    FROM auctions WHERE ${TRAIN} AND end_at > $cutoff
    AND ($endBefore IS NULL OR end_at < $endBefore) AND rowid % $sampleModulo = 0
    ORDER BY end_at, id LIMIT $limit`;
  const historySQL = `SELECT id, card_id, seller_id, rarity, is_shiny, listing_base_amount,
    base_repriced_at, status, final_price, end_at FROM auctions INDEXED BY auctions_card
    WHERE final = 1 AND status IN ('settled_sold', 'settled_unsold')
    AND card_id = $cardId AND rarity = $rarity AND is_shiny = $shiny`;
  let considered = 0, eligible = 0, n = 0, brier = 0, logLoss = 0;
  const samples = [], scores = includeScores ? [] : null, histories = new Map();
  const bins = Array.from({ length: 10 }, (_, i) => ({ bin: i, n: 0, sold: 0, predicted: 0 }));
  state.db.exec('BEGIN');
  try {
    for (const r of state.db.prepare(sql).iterate({ cutoff: Math.max(state.maxEndAt, startAfter ?? -Infinity),
      endBefore, sampleModulo, limit })) {
      considered++;
      const key = JSON.stringify([r.card_id, r.rarity, r.is_shiny]);
      let history = histories.get(key);
      if (!history) {
        history = state.db.prepare(historySQL).all({ cardId: r.card_id, rarity: r.rarity, shiny: r.is_shiny });
        histories.set(key, history);
      }
      // Strictly earlier end times avoid using the scored listing itself or
      // another auction that happened to settle at the same recorded instant.
      const prior = history.filter((item) => item.end_at != null && item.end_at < r.end_at);
      const finals = prior.filter((item) => item.status === 'settled_sold' &&
        Number.isFinite(item.final_price) && item.final_price > 0)
        .map((item) => item.final_price).sort((a, b) => a - b);
      if (finals.length < minSales) continue;
      const median = (finals[Math.floor((finals.length - 1) / 2)] +
        finals[Math.floor(finals.length / 2)]) / 2;
      if (median <= medianThreshold) continue;
      eligible++;
      if (r.listing_base_amount <= median) continue;
      const training = prior.filter((item) => item.base_repriced_at == null &&
        item.listing_base_amount >= 1);
      const repeated = new Map();
      for (const item of training) {
        const repeat = repeatKey(item);
        repeated.set(repeat, (repeated.get(repeat) ?? 0) + 1);
      }
      const chance = fitPremiumChance(training, repeated, median);
      const p = training.length ? sigmoid(chance.alpha - chance.beta *
        Math.log(r.listing_base_amount / chance.referencePrice) - calibrationShift) : 0;
      const y = r.status === 'settled_sold' ? 1 : 0;
      n++; brier += (p - y) ** 2;
      logLoss += -(y * Math.log(clip(p, 1e-9, 1)) + (1 - y) * Math.log(clip(1 - p, 1e-9, 1)));
      const bin = bins[Math.min(9, Math.floor(p * 10))];
      bin.n++; bin.sold += y; bin.predicted += p;
      if (samples.length < 20) samples.push({ auctionId: r.id, endAt: r.end_at,
        priorSoldCount: finals.length, priorMedian: median, ask: r.listing_base_amount,
        predicted: p, sold: Boolean(y) });
      if (scores) scores.push({ endAt: r.end_at, predicted: p, sold: y });
    }
  } finally { state.db.exec('COMMIT'); }
  return { considered, eligible, n, calibrationShift, brier: n ? brier / n : null,
    logLoss: n ? logLoss / n : null,
    bins: bins.map((b) => ({ bin: b.bin, n: b.n,
      observed: b.n ? b.sold / b.n : null,
      predicted: b.n ? b.predicted / b.n : null })), samples,
    ...(scores ? { scores } : {}) };
}

function fitPremiumCalibration(scores) {
  // Fit a single odds correction on a historical segment. It can reduce an
  // optimistic model but never raise its estimates above the exact-card fit.
  if (scores.length < 30) return 0;
  let shift = 0;
  for (let iteration = 0; iteration < 30; iteration++) {
    let residual = 0, information = 0;
    for (const row of scores) {
      const p = clip(row.predicted, 1e-9, 1 - 1e-9);
      const q = sigmoid(logit(p) - shift);
      residual += row.sold - q;
      information += q * (1 - q);
    }
    const step = clip(residual / Math.max(1e-9, information), -1, 1);
    shift = clip(shift - step, 0, 3);
    if (Math.abs(step) < 1e-5 || (shift === 0 && step > 0)) break;
  }
  return shift;
}

function calibratePremium(state) {
  const endAt = state.maxEndAt ?? state.dataTimestamp;
  if (!endAt) return { shift: 0, n: 0, windowStart: null, windowEnd: null };
  const windowStart = endAt - 12 * 60 * 60 * 1000;
  const evaluation = premiumHoldout({ ...state, maxEndAt: windowStart }, {
    limit: 12000, minSales: 4, medianThreshold: 500, sampleModulo: 40,
    endBefore: endAt, includeScores: true, calibrationShift: 0,
  });
  const shift = fitPremiumCalibration(evaluation.scores);
  return { shift, n: evaluation.n, rawBrier: evaluation.brier,
    rawPredicted: evaluation.scores.reduce((sum, row) => sum + row.predicted, 0) / (evaluation.n || 1),
    observed: evaluation.scores.reduce((sum, row) => sum + row.sold, 0) / (evaluation.n || 1),
    windowStart, windowEnd: endAt };
}

export class MarketModel {
  constructor({ dbPath, maxEndAt = null, calibrationCachePath = null } = {}) {
    if (!dbPath) throw new Error('dbPath is required');
    this.worker = new Worker(new URL(import.meta.url), {
      workerData: { role: 'market-model', dbPath, maxEndAt, calibrationCachePath },
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
    });
    this.nextId = 1;
    this.pending = new Map();
    this.readyPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.worker.on('message', (message) => {
      if (message.type === 'ready') { this.readyResolve(message.dataTimestamp); return; }
      if (message.type === 'fatal') { this._fail(new Error(message.error)); return; }
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error));
      else task.resolve(message.result);
    });
    this.worker.on('error', (error) => this._fail(error));
    this.worker.on('exit', (code) => { if (code !== 0 && !this.closed) this._fail(new Error(`model worker exited ${code}`)); });
  }

  _fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.readyReject(error);
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    this.termination = this.worker.terminate().catch(() => {});
  }

  ready() { return this.readyPromise; }

  async _call(type, payload) {
    await this.ready();
    if (this.closed) throw new Error('market model is closed');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  quote(facts, options) { return this._call('quote', { facts, options }); }
  dealQuote(facts, options) { return this._call('dealQuote', { facts, options }); }
  stats(facts) { return this._call('stats', { facts }); }
  purchaseAuctions(sellerId, purchases) { return this._call('purchaseAuctions', { sellerId, purchases }); }
  quoteAtPrices(facts, prices, options) {
    return this._call('quoteAtPrices', { facts, prices, options });
  }
  health() { return this._call('health', {}); }
  refresh() { return this._call('refresh', {}); }
  evaluateHoldout({ limit = 5000 } = {}) { return this._call('holdout', { limit }); }
  evaluatePremiumHoldout(options) { return this._call('premiumHoldout', { options }); }
  async close() {
    if (this.closed) return this.termination;
    this.closed = true;
    // Closing can race initial publication, before anyone has awaited ready().
    this.readyPromise.catch(() => {});
    this.readyReject(new Error('market model is closed'));
    for (const task of this.pending.values()) task.reject(new Error('market model is closed'));
    this.pending.clear();
    this.termination = this.worker.terminate();
    await this.termination;
  }
}

export async function createMarketModel(options) {
  const model = new MarketModel(options);
  try {
    await model.ready();
    return model;
  } catch (error) {
    await model.close();
    throw error;
  }
}

if (!isMainThread && workerData?.role === 'market-model') {
  let db, state;
  const saveCalibration = () => {
    // A cache failure must not interrupt pricing. The analyzer remains the
    // only database writer; this is a separate, small private runtime file.
    if (workerData.maxEndAt != null) return;
    try { writePremiumCalibrationCache(workerData.calibrationCachePath, workerData.dbPath, state.premiumCalibration); }
    catch (error) { console.warn(`market calibration cache: ${error.message}`); }
  };
  try {
    db = new DatabaseSync(workerData.dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    state = build(db, workerData.maxEndAt,
      readPremiumCalibrationCache(workerData.calibrationCachePath, workerData.dbPath));
    saveCalibration();
    parentPort.postMessage({ type: 'ready', dataTimestamp: state.dataTimestamp });
  } catch (error) {
    parentPort.postMessage({ type: 'fatal', error: error.message });
  }
  let chain = Promise.resolve();
  parentPort.on('message', (message) => {
    chain = chain.then(() => {
      try {
        let result;
        if (message.type === 'quote') result = coreQuote(state, message.facts, message.options);
        else if (message.type === 'dealQuote') result = hybridDealQuote(state, message.facts, message.options);
        else if (message.type === 'stats') result = exactSaleStats(state, message.facts);
        else if (message.type === 'purchaseAuctions') {
          if (!message.sellerId) throw new Error('purchase auction history needs an account');
          const query = db.prepare(`SELECT id, card_id, seller_id, rarity AS snapshot_rarity,
            is_shiny, listing_base_amount, status, final_price, created_at, end_at, settled_at
            FROM auctions INDEXED BY auctions_card WHERE card_id = ? AND seller_id = ?
            AND rarity = ? AND is_shiny = ? AND created_at >= ? ORDER BY created_at LIMIT 201`);
          result = (message.purchases ?? []).slice(0, 50).flatMap((p) =>
            query.all(p.cardId, message.sellerId, p.rarity, Number(Boolean(p.shiny)), p.purchasedAt)
              .map((a) => ({ ...a, ...Object.fromEntries(['created_at', 'end_at', 'settled_at']
                .map((key) => [key, a[key] == null ? null : new Date(a[key]).toISOString()])) })));
        }
        else if (message.type === 'quoteAtPrices') result = premiumQuoteAtPrices(state,
          message.facts, message.prices, message.options);
        else if (message.type === 'health') result = { ready: true, dataTimestamp: state.dataTimestamp,
          peerGroups: state.parents.size, cardsWithHistory: state.children.size,
          premiumCalibration: state.premiumCalibration, premiumCalibrationReused: state.premiumCalibrationReused };
        else if (message.type === 'refresh') {
          state = build(db, workerData.maxEndAt, state.premiumCalibration);
          saveCalibration();
          result = { dataTimestamp: state.dataTimestamp };
        }
        else if (message.type === 'holdout') result = holdout(state, message.limit);
        else if (message.type === 'premiumHoldout') result = premiumHoldout(state, message.options);
        else throw new Error(`unknown model operation ${message.type}`);
        parentPort.postMessage({ id: message.id, result });
      } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
    });
  });
}
