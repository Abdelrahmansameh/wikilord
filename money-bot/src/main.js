import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadPremiumConfig, ROOT, CONFIG_PATH, PREMIUM_CONFIG_PATH } from './config.js';
import { Session, PREMIUM_SESSION_FILE, PREMIUM_ENV_FILE } from './session.js';
import { StateStore, PREMIUM_STATE_PATH, PREMIUM_EVENTS_PATH, EVENTS_PATH } from './state.js';
import { MarketModel } from './model.js';
import { createSharedMarketModel } from './shared-model.js';
import { createMoneyEngine } from './engine.js';
import { createDealEngine } from './deals.js';
import { accountConflicts, startDashboard } from './server.js';

const config = loadConfig();
const premiumConfig = loadPremiumConfig();
if (!process.env.WM_MARKET_DB && path.resolve(fileURLToPath(ROOT), config.marketDb)
    !== path.resolve(fileURLToPath(ROOT), premiumConfig.marketDb))
  throw new Error('Both money accounts must use the same marketDb path');
const dbPath = process.env.WM_MARKET_DB ?? path.resolve(fileURLToPath(ROOT), config.marketDb);
const liveRequested = process.argv.includes('--live');
const premiumLiveRequested = process.argv.includes('--live-premium');
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

const session = new Session({ allowRenewal: true });
const premiumSession = new Session({ sessionFile: PREMIUM_SESSION_FILE, envFile: PREMIUM_ENV_FILE, allowRenewal: true });
session.onLog = (message) => log(`standard: ${message}`);
premiumSession.onLog = (message) => log(`premium: ${message}`);

const sharedModel = createSharedMarketModel({ replaceOnRefresh: true, open: () => new MarketModel({ dbPath,
  calibrationCachePath: path.resolve(fileURLToPath(ROOT), 'market-calibration.cache.json') }) });
const model = {
  ...sharedModel,
  dealQuote: async (facts, options = {}) => sharedModel.dealQuote(facts, {
    ...options,
    controlledUserIds: [...new Set([
      ...(options.controlledUserIds ?? []), session.userId?.(), premiumSession.userId?.(),
    ].filter(Boolean))],
  }),
};

const sessions = { standard: session, premium: premiumSession };
const allowed = (account) => (id) => !accountConflicts(id, { account, sessions });
const engine = createMoneyEngine({
  session, model, config, log: (message) => log(`standard: ${message}`), liveRequested,
  accountAllowed: allowed('standard'),
});
const premiumStore = new StateStore({ file: PREMIUM_STATE_PATH, eventFile: PREMIUM_EVENTS_PATH, account: 'premium' });
premiumStore.data.accountId ??= premiumSession.userId?.() ?? null;
premiumStore.save();
const premiumEngine = createMoneyEngine({
  session: premiumSession, model, config: premiumConfig, store: premiumStore,
  log: (message) => log(`premium: ${message}`), liveRequested: premiumLiveRequested,
  accountAllowed: allowed('premium'),
});
const deals = createDealEngine({
  session: premiumSession, model, config: premiumConfig, store: premiumStore,
  log: (message) => log(`premium deal: ${message}`),
  getPortfolio: () => premiumEngine.getPortfolio(),
  accountAllowed: allowed('premium'), liveRequested: premiumLiveRequested,
  dbPath,
});
premiumEngine.setDealEngine(deals);
const dashboard = startDashboard({
  accounts: {
    standard: { engine, session, config, configFile: CONFIG_PATH, historyFile: EVENTS_PATH },
    premium: { engine: premiumEngine, session: premiumSession, config: premiumConfig,
      configFile: PREMIUM_CONFIG_PATH, historyFile: PREMIUM_EVENTS_PATH, store: premiumStore },
  },
  model, config, log,
});

log(`standard money account: ${liveRequested && !config.dryRun ? 'LIVE' : 'DRY-RUN'}; premium account: ${premiumLiveRequested && !premiumConfig.dryRun ? 'LIVE' : 'DRY-RUN'}; analyzer DB: ${dbPath}`);
for (const [name, ownSession] of Object.entries(sessions)) {
  try { await ownSession.init(); }
  catch (error) { log(`${name} API key discovery: ${error.message}; retrying later`); }
}
setInterval(() => {
  for (const [name, ownSession] of Object.entries(sessions))
    ownSession.init().catch((error) => log(`${name} API key discovery: ${error.message}`));
}, 10 * 60_000);

for (const [name, ownSession, ownEngine] of [
  ['standard', session, engine], ['premium', premiumSession, premiumEngine],
]) {
  if (!ownSession.hasCookie()) {
    log(`connect the ${name} account at http://localhost:${config.ui.port}${name === 'premium' ? '/premium' : ''}`);
  } else if (!allowed(name)(ownSession.userId())) {
    log(`${name} startup blocked: this login is already used by another bot account`);
  } else ownEngine.start();
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all([engine.stop(), premiumEngine.stop()]);
  dashboard.close();
  await model.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
