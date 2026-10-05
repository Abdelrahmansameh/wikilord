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
const store = new Store(fileURLToPath(new URL(cfg.dbFile, ROOT)), { log });
const primary = new Session();
const secondary = new Session(undefined, 'secondary');
const tertiary = new Session(undefined, 'tertiary');
primary.onLog = (m) => log(`account 1: ${m}`);
secondary.onLog = (m) => log(`account 2: ${m}`);
tertiary.onLog = (m) => log(`account 3: ${m}`);
try {
  await primary.init();
} catch (e) {
  log(`could not fetch the site's API key yet (${e.message}); token refresh will fail until it is found`);
}

const pool = new AccountPool([primary, secondary, tertiary], cfg, log);
if (!store.getMeta('scout_mode_started_ms')) store.setMeta('scout_mode_started_ms', Date.now());
const collector = new Collector(store, pool, cfg, log, { slots: ['primary', 'secondary'] });
const scout = new Collector(store, pool, { ...cfg, pollMs: cfg.scoutPollMs,
  recentPollMs: cfg.scoutRecentPollMs }, (m) => log(`scout: ${m}`), {
  slots: ['tertiary'], listingOnly: true, progressPrefix: 'scout_', onPending: (rows) => collector.schedule(rows),
});
collector.scout = scout;
// Historical diagnostics can take time on a cold database; collection and HTTP must start immediately.
const analysis = await new AnalysisClient(store.file, { log }).start({ waitForStatus: false });
const server = startServer({ cfg, analysis, collector, pool, log });

if (!pool.activeCount) log('no login cookie yet: paste one on the dashboard');
else log(`active market accounts: ${pool.status().filter((a) => a.hasCookie && !a.blockedReason).map((a) => a.username ?? a.slot).join(', ')}`);
collector.start();
scout.start();

// Readable progress in the console every minute.
setInterval(() => {
  const s = collector.status();
  const m = s.last5min;
  log(
    `last 5 min: ${m.settled ?? 0} recorded (${m.sold ?? 0} sold), ${m.discovered ?? 0} new, ${m.requests ?? 0} requests, ` +
      `${m.errors ?? 0} errors | waiting: ${s.pending} (${s.overdue} due)${s.needsLogin ? ' | NEEDS LOGIN' : ''}`,
  );
}, 60_000);

// Keep the planner statistics current as the tables grow (a no-op when nothing changed much).
setInterval(() => {
  try {
    store.optimize();
  } catch (e) {
    log(`database optimize: ${e.message}`);
  }
}, 6 * 3600e3).unref();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  collector.stop();
  scout.stop();
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
