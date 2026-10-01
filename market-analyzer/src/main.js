import { fileURLToPath } from 'node:url';
import { loadConfig, ROOT } from './config.js';
import { Store } from './db.js';
import { Session } from './http.js';
import { AccountPool } from './accounts.js';
import { Collector } from './collector.js';
import { AnalysisClient } from './analysis-client.js';
import { startServer } from './server.js';

const log = (m) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), m);

const cfg = loadConfig();
const store = new Store(fileURLToPath(new URL(cfg.dbFile, ROOT)));
const primary = new Session();
const secondary = new Session(undefined, 'secondary');
primary.onLog = (m) => log(`account 1: ${m}`);
secondary.onLog = (m) => log(`account 2: ${m}`);
try {
  await primary.init();
} catch (e) {
  log(`could not fetch the site's API key yet (${e.message}); token refresh will fail until it is found`);
}

const pool = new AccountPool([primary, secondary], cfg, log);
const collector = new Collector(store, pool, cfg, log);
const analysis = await new AnalysisClient(store.file, { log }).start();
const server = startServer({ cfg, analysis, collector, pool, log });

if (!pool.activeCount) log('no login cookie yet: paste one on the dashboard');
else log(`active market accounts: ${pool.status().filter((a) => a.hasCookie && !a.blockedReason).map((a) => a.username ?? a.slot).join(', ')}`);
collector.start();

// Readable progress in the console every minute.
setInterval(() => {
  const s = collector.status();
  const m = s.last5min;
  log(
    `last 5 min: ${m.settled ?? 0} recorded (${m.sold ?? 0} sold), ${m.discovered ?? 0} new, ${m.requests ?? 0} requests, ` +
      `${m.errors ?? 0} errors | waiting: ${s.pending} (${s.overdue} due)${s.needsLogin ? ' | NEEDS LOGIN' : ''}`,
  );
}, 60_000);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  collector.stop();
  server.close();
  await analysis.close();
  try {
    store.db.exec('PRAGMA optimize');
    store.db.close();
  } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
