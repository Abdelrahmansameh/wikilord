// This worker uses no sessions or network requests: only a read-only connection to the collector's WAL database.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { Analysis } from './analysis.js';
import { Store } from './db.js';

const db = new DatabaseSync(workerData.file, { readOnly: true });
// The readers share the same machine with the collector and browser. Bound each reader's resident caches;
// multi-GB mappings and 128 MB page caches per worker caused memory pressure during concurrent cold scans.
db.exec(`
  PRAGMA query_only = ON;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -32768;
  PRAGMA mmap_size = 268435456;
  PRAGMA busy_timeout = 5000;
`);
// Reuse just the store's read methods; never run its constructor, migrations, or write statements.
const reader = { db, raw: Store.prototype.raw, ingestionInfo: Store.prototype.ingestionInfo };
const analysis = new Analysis(reader);
const methods = new Set([
  'overview', 'turnover', 'auctionAppearances', 'prices', 'startingPrice', 'scatter', 'categoryGroups', 'categoryDetail',
  'timing', 'players', 'auctions', 'auction', 'cards', 'cardRankings', 'card', 'comparable', 'users',
]);

parentPort.on('message', ({ id, method, args }) => {
  try {
    let value;
    // Feed/account counts scan the whole auctions table; they are diagnostics, so a few minutes old is fine.
    if (method === 'status') value = { db: analysis.dbInfo(), ingestion: reader.ingestionInfo(300_000) };
    else if (method === 'raw') value = reader.raw(...args);
    else if (methods.has(method)) value = analysis[method](...args);
    else throw new Error(`Unknown analysis method: ${method}`);
    parentPort.postMessage({ id, value });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});

parentPort.on('close', () => db.close());
