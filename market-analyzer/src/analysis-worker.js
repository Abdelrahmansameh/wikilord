// This worker uses no sessions or network requests: only a read-only connection to the collector's WAL database.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { Analysis } from './analysis.js';
import { Store } from './db.js';

const db = new DatabaseSync(workerData.file, { readOnly: true });
db.exec(`
  PRAGMA query_only = ON;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -65536;
  PRAGMA mmap_size = 536870912;
  PRAGMA busy_timeout = 5000;
`);
// Reuse just the store's read methods; never run its constructor, migrations, or write statements.
const reader = { db, raw: Store.prototype.raw, ingestionInfo: Store.prototype.ingestionInfo };
const analysis = new Analysis(reader);
const methods = new Set([
  'overview', 'turnover', 'prices', 'startingPrice', 'scatter', 'categoryGroups', 'categoryDetail',
  'timing', 'players', 'auctions', 'auction', 'cards', 'card', 'comparable', 'users',
]);

parentPort.on('message', ({ id, method, args }) => {
  try {
    let value;
    if (method === 'status') value = { db: analysis.dbInfo(), ingestion: reader.ingestionInfo() };
    else if (method === 'raw') value = reader.raw(...args);
    else if (methods.has(method)) value = analysis[method](...args);
    else throw new Error(`Unknown analysis method: ${method}`);
    parentPort.postMessage({ id, value });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});

parentPort.on('close', () => db.close());
