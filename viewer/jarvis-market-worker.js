// No sessions, network, migrations, user SQL, or database writes are available in this worker.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(workerData.file, { readOnly: true, allowExtension: false });
db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; PRAGMA cache_size = -8192; PRAGMA temp_store = MEMORY;');
try {
  const rows = db.prepare(workerData.sql).all(...workerData.params);
  parentPort.postMessage({ rows });
} catch {
  parentPort.postMessage({ error: 'The read-only market query could not be completed.' });
} finally { db.close(); }
