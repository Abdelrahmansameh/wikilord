import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HYBRID_BUY_DEFAULTS, loadConfig, patchOperationalSettings, validateConfig } from '../src/config.js';

const example = () => JSON.parse(readFileSync(new URL('../premium.config.example.json', import.meta.url)));
const legacy = () => {
  const config = example();
  for (const key of Object.keys(HYBRID_BUY_DEFAULTS)) delete config.buy[key];
  return config;
};

test('duration experiment is opt-in, validated and editable on legacy premium configs', () => {
  const current = example();
  delete current.premium.listingDurationExperiment;
  const next = patchOperationalSettings(current, [{ path: 'premium.listingDurationExperiment', value: true }], { premium: true });
  assert.equal(next.premium.listingDurationExperiment, true);
  assert.equal(current.premium.listingDurationExperiment, undefined);
  next.premium.listingDurationExperiment = 'true';
  assert.ok(validateConfig(next, { premium: true }).some((message) => message.includes('listingDurationExperiment')));
});

test('hybrid examples validate and legacy accounts acquire editable defaults without activation', () => {
  assert.deepEqual(validateConfig(example(), { premium: true }), []);
  assert.deepEqual(validateConfig(legacy(), { premium: true }), []);
  const dir = mkdtempSync(join(tmpdir(), 'wm-hybrid-config-'));
  const file = join(dir, 'premium.config.json');
  const config = legacy();
  config.buy.minProfit = 234;
  config.buy.scanSeconds = 47;
  writeFileSync(file, JSON.stringify(config));
  try {
    const loaded = loadConfig(file, { premium: true });
    assert.equal(loaded.buy.hybridEnabled, false);
    assert.equal(loaded.buy.resaleAttempts, 6);
    assert.equal(loaded.buy.maxQueueSize, 2000);
    assert.equal(loaded.buy.minProfit, 234);
    assert.equal(loaded.buy.scanSeconds, 47);
    assert.equal(JSON.parse(readFileSync(file)).buy.hybridEnabled, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hybrid validation rejects impossible evidence, resale, queue, and probability settings', () => {
  const invalid = {
    hybridEnabled: 'true', liquidMinSold: 0, minBuyers: 1.5, minSellers: null,
    resaleAttempts: 25, repeatCorrelation: -0.1, horizonProbability: 0,
    probabilityRiskWeight: 1.1, premiumMinProfit: -1, premiumMinRoi: -0.1,
    liquidMinProfit: Infinity, liquidMinRoi: NaN, maxBuyRatio: 1.1, liquidResaleAskRatio: 0,
    quoteCacheSeconds: 0, maxQueueSize: 10001, maxPlans: 0,
    maxResaleExposure: 6, minProfitPerSlotHour: -1, slotOpportunityCoinsPerHour: NaN,
    residualValueRatio: 1.1, minAttemptProbability: -0.1,
    planningHorizonMinutes: 0, liveRefreshLeadSeconds: 0,
    maxLiveRefreshPerScan: 0, liveRequestGapMs: 30001,
  };
  for (const [key, value] of Object.entries(invalid)) {
    const config = example();
    config.buy[key] = value;
    assert.ok(validateConfig(config, { premium: true }).some(error => error.startsWith(`buy.${key} `)), key);
  }
  const config = example();
  config.buy.maxQueueSize = 50;
  config.buy.maxPlans = 100;
  assert.ok(validateConfig(config, { premium: true }).includes('buy.maxPlans must not exceed buy.maxQueueSize'));
});

test('operational edits can enable hybrid on a legacy account without mutating its existing settings', () => {
  const config = legacy();
  const next = patchOperationalSettings(config, [
    { path: 'buy.hybridEnabled', value: true },
    { path: 'buy.premiumMinProfit', value: 85 },
    { path: 'buy.maxQueueSize', value: 3000 },
  ], { premium: true });
  assert.equal(next.buy.hybridEnabled, true);
  assert.equal(next.buy.premiumMinProfit, 85);
  assert.equal(next.buy.maxQueueSize, 3000);
  assert.equal(next.buy.minProfit, config.buy.minProfit);
  assert.equal(config.buy.hybridEnabled, undefined);
  assert.throws(() => patchOperationalSettings(config, [{ path: 'buy.resaleAttempts', value: 0 }], { premium: true }), /resaleAttempts/);
  assert.throws(() => patchOperationalSettings(config, [{ path: 'buy.unknownRule', value: 1 }], { premium: true }), /Unknown setting/);
});
