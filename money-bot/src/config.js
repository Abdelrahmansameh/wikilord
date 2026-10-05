import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = new URL('../', import.meta.url);
export const CONFIG_PATH = new URL('config.json', ROOT);
const EXAMPLE_PATH = new URL('config.example.json', ROOT);
export const PREMIUM_CONFIG_PATH = new URL('premium.config.json', ROOT);
const PREMIUM_EXAMPLE_PATH = new URL('premium.config.example.json', ROOT);

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const nonnegative = (n) => finite(n) && n >= 0;
const positive = (n) => finite(n) && n > 0;
const range = (r) => Array.isArray(r) && r.length === 2 && r.every(nonnegative) && r[0] <= r[1];

// Existing accounts retain their strategy until hybrid buying is explicitly enabled.
export const HYBRID_BUY_DEFAULTS = Object.freeze({
  hybridEnabled: false,
  liquidMinSold: 12,
  minBuyers: 4,
  minSellers: 3,
  resaleAttempts: 6,
  repeatCorrelation: 0.5,
  horizonProbability: 0.85,
  probabilityRiskWeight: 0.5,
  premiumMinProfit: 200,
  premiumMinRoi: 0.35,
  liquidMinProfit: 75,
  liquidMinRoi: 0.6,
  liquidResaleAskRatio: 0.8,
  maxBuyRatio: 0.6,
  maxResaleExposure: 5,
  minProfitPerSlotHour: 50,
  slotOpportunityCoinsPerHour: 25,
  residualValueRatio: 0,
  minAttemptProbability: 0.65,
  quoteCacheSeconds: 60,
  maxQueueSize: 2000,
  maxPlans: 5,
  planningHorizonMinutes: 15,
  liveRefreshLeadSeconds: 90,
  maxLiveRefreshPerScan: 12,
  liveRequestGapMs: 350,
});

export function validateConfig(c, { premium = Boolean(c?.premium || c?.buy) } = {}) {
  const errors = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['config must be an object'];
  if (typeof c.dryRun !== 'boolean') errors.push('dryRun must be true or false');
  if (!positive(c.cycleMinutes)) errors.push('cycleMinutes must be positive');
  if (!Number.isInteger(c.maxActionsPerCycle) || c.maxActionsPerCycle < 1) errors.push('maxActionsPerCycle must be a positive integer');
  if (!range(c.actionGapMs)) errors.push('actionGapMs must be [min,max] milliseconds');
  if (!Number.isInteger(c.ui?.port) || c.ui.port < 1 || c.ui.port > 65535) errors.push('ui.port must be a TCP port');
  if (typeof c.packs?.enabled !== 'boolean') errors.push('packs.enabled must be true or false');
  if (!Number.isInteger(c.packs?.maxPerCycle) || c.packs.maxPerCycle < 0) errors.push('packs.maxPerCycle must be a nonnegative integer');
  if (!range(c.packs?.gapMs)) errors.push('packs.gapMs must be [min,max] milliseconds');
  if (!positive(c.packs?.backoffMinutes)) errors.push('packs.backoffMinutes must be positive');
  if (c.listing?.durationMinutes !== 60) errors.push('listing.durationMinutes must be 60 for v1');
  if (!Number.isInteger(c.listing?.maxConcurrent) || c.listing.maxConcurrent < 1 || c.listing.maxConcurrent > 5)
    errors.push('listing.maxConcurrent must be 1 to 5');
  if (!nonnegative(c.recycleValue)) errors.push('recycleValue must be nonnegative');
  if (!nonnegative(c.listingFee)) errors.push('listingFee must be nonnegative');
  if (!finite(c.targetProbability) || c.targetProbability <= 0 || c.targetProbability > 1)
    errors.push('targetProbability must be in (0,1]');
  for (const k of ['outcomePenalty', 'modelLowerPenalty', 'modelUpperBonus'])
    if (!nonnegative(c[k])) errors.push(`${k} must be nonnegative`);
  if (!positive(c.arrivalWindowHours)) errors.push('arrivalWindowHours must be positive');
  if (!Number.isInteger(c.minArrivalObservations) || c.minArrivalObservations < 2)
    errors.push('minArrivalObservations must be an integer >= 2');
  if (!positive(c.maxMarketAgeHours)) errors.push('maxMarketAgeHours must be positive');
  if (!positive(c.modelRefreshMinutes)) errors.push('modelRefreshMinutes must be positive');
  if (typeof c.marketDb !== 'string' || !c.marketDb.trim()) errors.push('marketDb must be a path');
  if (premium) {
    if (c.premium?.listingDurationExperiment !== undefined && typeof c.premium.listingDurationExperiment !== 'boolean')
      errors.push('premium.listingDurationExperiment must be true or false');
    if (typeof c.premium?.enabled !== 'boolean') errors.push('premium.enabled must be true or false');
    if (!Number.isInteger(c.premium?.minSold) || c.premium.minSold < 1 || c.premium.minSold > 10000)
      errors.push('premium.minSold must be an integer from 1 to 10000');
    if (!nonnegative(c.premium?.minMedian) || c.premium.minMedian > 1e9)
      errors.push('premium.minMedian must be from 0 to 1 billion');
    if (!finite(c.premium?.maxAskRatio) || c.premium.maxAskRatio <= 1 || c.premium.maxAskRatio > 10)
      errors.push('premium.maxAskRatio must be in (1,10]');
    if (!finite(c.premium?.minSaleProbability) || c.premium.minSaleProbability <= 0 || c.premium.minSaleProbability > 1)
      errors.push('premium.minSaleProbability must be in (0,1]');
    if (!finite(c.premium?.stepDownPct) || c.premium.stepDownPct <= 0 || c.premium.stepDownPct >= 1)
      errors.push('premium.stepDownPct must be in (0,1)');
    if (typeof c.buy?.enabled !== 'boolean') errors.push('buy.enabled must be true or false');
    if (!Number.isInteger(c.buy?.minSold) || c.buy.minSold < 1 || c.buy.minSold > 10000)
      errors.push('buy.minSold must be an integer from 1 to 10000');
    if (!Number.isInteger(c.buy?.topCount) || c.buy.topCount < 1 || c.buy.topCount > 50000)
      errors.push('buy.topCount must be an integer from 1 to 50000');
    if (!nonnegative(c.buy?.minProfit) || c.buy.minProfit > 1e9)
      errors.push('buy.minProfit must be from 0 to 1 billion');
    if (!finite(c.buy?.exitProbability) || c.buy.exitProbability <= 0 || c.buy.exitProbability > 1)
      errors.push('buy.exitProbability must be in (0,1]');
    if (!nonnegative(c.buy?.reserveCoins) || c.buy.reserveCoins > 1e12)
      errors.push('buy.reserveCoins must be from 0 to 1 trillion');
    if (!finite(c.buy?.reserveFraction) || c.buy.reserveFraction < 0 || c.buy.reserveFraction > 1)
      errors.push('buy.reserveFraction must be in [0,1]');
    if (!finite(c.buy?.scanSeconds) || c.buy.scanSeconds < 5 || c.buy.scanSeconds > 3600)
      errors.push('buy.scanSeconds must be from 5 to 3600');
    for (const key of ['freshLookbackMinutes', 'topRefreshMinutes'])
      if (!finite(c.buy?.[key]) || c.buy[key] < 1 || c.buy[key] > 10080)
        errors.push(`buy.${key} must be from 1 to 10080`);
    for (const key of ['maxRowsPerScan', 'maxQuotesPerScan'])
      if (!Number.isInteger(c.buy?.[key]) || c.buy[key] < 1
          || c.buy[key] > (key === 'maxRowsPerScan' ? 50000 : 1000))
        errors.push(`buy.${key} is outside its supported range`);
    for (const key of ['targetRemainingMs', 'preCheckLeadMs', 'extraBidLatencyMs', 'minGapBetweenBidsMs']) {
      const max = key === 'extraBidLatencyMs' ? 30000 : 300000;
      if (!nonnegative(c.buy?.[key]) || c.buy[key] > max)
        errors.push(`buy.${key} must be from 0 to ${max}`);
    }
    if (!Number.isInteger(c.buy?.maxCounters) || c.buy.maxCounters < 0 || c.buy.maxCounters > 20)
      errors.push('buy.maxCounters must be an integer from 0 to 20');
    if (!Number.isInteger(c.buy?.bidIncrement) || c.buy.bidIncrement < 1 || c.buy.bidIncrement > 1e9)
      errors.push('buy.bidIncrement must be an integer from 1 to 1 billion');
    if (c.buy?.hybridEnabled !== undefined && typeof c.buy.hybridEnabled !== 'boolean')
      errors.push('buy.hybridEnabled must be true or false');
    const optionalIntegerRanges = {
      liquidMinSold: [1, 10000], minBuyers: [1, 10000], minSellers: [1, 10000],
      resaleAttempts: [1, 24], maxQueueSize: [1, 10000], maxPlans: [1, 1000], maxResaleExposure: [1, 5],
      maxLiveRefreshPerScan: [1, 1000], liveRequestGapMs: [0, 30000],
    };
    for (const [key, [min, max]] of Object.entries(optionalIntegerRanges)) {
      const value = c.buy?.[key];
      if (value !== undefined && (!Number.isInteger(value) || value < min || value > max))
        errors.push(`buy.${key} must be an integer from ${min} to ${max}`);
    }
    const optionalNumberRanges = {
      repeatCorrelation: [0, 1], probabilityRiskWeight: [0, 1],
      premiumMinProfit: [0, 1e9], liquidMinProfit: [0, 1e9],
      premiumMinRoi: [0, 10], liquidMinRoi: [0, 10],
      minProfitPerSlotHour: [0, 1e9], slotOpportunityCoinsPerHour: [0, 1e9],
      residualValueRatio: [0, 1], minAttemptProbability: [0, 1],
      quoteCacheSeconds: [1, 3600], planningHorizonMinutes: [1, 1440],
      liveRefreshLeadSeconds: [1, 3600],
    };
    for (const [key, [min, max]] of Object.entries(optionalNumberRanges)) {
      const value = c.buy?.[key];
      if (value !== undefined && (!finite(value) || value < min || value > max))
        errors.push(`buy.${key} must be from ${min} to ${max}`);
    }
    for (const key of ['horizonProbability', 'maxBuyRatio', 'liquidResaleAskRatio']) {
      const value = c.buy?.[key];
      if (value !== undefined && (!finite(value) || value <= 0 || value > 1))
        errors.push(`buy.${key} must be in (0,1]`);
    }
    if (c.buy?.maxPlans !== undefined && c.buy?.maxQueueSize !== undefined && c.buy.maxPlans > c.buy.maxQueueSize)
      errors.push('buy.maxPlans must not exceed buy.maxQueueSize');
    if (c.trades != null) {
      if (typeof c.trades.acceptIncoming !== 'boolean') errors.push('trades.acceptIncoming must be true or false');
      if (!Number.isInteger(c.trades.pollSeconds) || c.trades.pollSeconds < 5 || c.trades.pollSeconds > 3600)
        errors.push('trades.pollSeconds must be from 5 to 3600');
      if (!Number.isInteger(c.trades.acceptGapMs) || c.trades.acceptGapMs < 0 || c.trades.acceptGapMs > 30000)
        errors.push('trades.acceptGapMs must be from 0 to 30000');
    }
  }
  return errors;
}

export function loadConfig(path = CONFIG_PATH, { examplePath = EXAMPLE_PATH, premium = false } = {}) {
  if (!fs.existsSync(path)) fs.copyFileSync(examplePath, path);
  const c = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (premium && c.premium) c.premium = { listingDurationExperiment: false, ...c.premium };
  if (premium && c.trades == null) c.trades = { acceptIncoming: false, pollSeconds: 30, acceptGapMs: 1000 };
  if (premium && c.buy && typeof c.buy === 'object' && !Array.isArray(c.buy))
    c.buy = { ...HYBRID_BUY_DEFAULTS, ...c.buy };
  const errors = validateConfig(c, { premium });
  if (errors.length) throw new Error(`money bot config invalid: ${errors.join('; ')}`);
  return c;
}

export const loadPremiumConfig = () => loadConfig(PREMIUM_CONFIG_PATH, { examplePath: PREMIUM_EXAMPLE_PATH, premium: true });

export const SETTINGS_KEYS = new Set(['cycleMinutes', 'maxActionsPerCycle', 'actionGapMs', 'packs', 'listing',
  'replacement', 'targetProbability', 'outcomePenalty', 'modelLowerPenalty', 'modelUpperBonus',
  'arrivalWindowHours', 'minArrivalObservations', 'maxMarketAgeHours', 'modelRefreshMinutes',
  'premium', 'buy', 'trades']);

/** Only known operational fields; connection details and live activation stay owner-controlled. */
export function patchOperationalSettings(current, changes, { premium = false } = {}) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 50) throw new Error('Send 1-50 settings changes.');
  const next = structuredClone(current);
  if (premium && next.premium) next.premium = { listingDurationExperiment: false, ...next.premium };
  if (premium && next.buy && typeof next.buy === 'object' && !Array.isArray(next.buy))
    next.buy = { ...HYBRID_BUY_DEFAULTS, ...next.buy };
  const knownShape = (value, previous) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Unknown settings object.');
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key) || !Object.hasOwn(previous, key)) throw new Error(`Unknown setting ${key}.`);
        knownShape(child, previous[key]);
      }
    }
  };
  for (const change of changes) {
    if (!change || typeof change.path !== 'string' || !Object.hasOwn(change, 'value') || Object.keys(change).some((key) => !['path', 'value'].includes(key))) throw new Error('Each change needs path and value.');
    const keys = change.path.split('.');
    if (!SETTINGS_KEYS.has(keys[0]) || !premium && ['premium', 'buy', 'trades'].includes(keys[0])
      || keys.some((key) => !/^[A-Za-z][A-Za-z0-9]*$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key))) throw new Error(`Setting ${change.path} is not editable here.`);
    let part = next;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(part, key) || !part[key] || typeof part[key] !== 'object' || Array.isArray(part[key])) throw new Error(`Unknown setting ${change.path}.`);
      part = part[key];
    }
    if (!Object.hasOwn(part, keys.at(-1))) throw new Error(`Unknown setting ${change.path}.`);
    knownShape(change.value, part[keys.at(-1)]);
    part[keys.at(-1)] = structuredClone(change.value);
  }
  const errors = validateConfig(next, { premium });
  if (next.replacement && (typeof next.replacement.enabled !== 'boolean'
    || !nonnegative(next.replacement.minGainCoins) || !positive(next.replacement.minRatio))) errors.push('Invalid listing replacement settings.');
  if (errors.length) throw new Error(errors.join('; '));
  return next;
}

/** Commit a fully validated replacement without exposing a partially written settings file. */
export function saveConfigAtomic(config, file = PREMIUM_CONFIG_PATH, { premium = true } = {}) {
  const errors = validateConfig(config, { premium });
  if (errors.length) throw new Error(errors.join('; '));
  const name = typeof file === 'string' ? file : fileURLToPath(file);
  const tmp = `${name}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(tmp, name);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}
