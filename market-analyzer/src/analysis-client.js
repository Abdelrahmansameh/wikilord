import { Worker } from 'node:worker_threads';

// Range aggregates scan hundreds of thousands of rows and can take seconds. They run on their own workers,
// so card, auction and search lookups (milliseconds) never queue behind them.
const HEAVY = new Set(['overview', 'turnover', 'auctionAppearances', 'prices', 'startingPrice', 'scatter',
  'categoryGroups', 'categoryDetail', 'timing', 'players', 'cardRankings', 'comparable']);
// Browse can search/sort millions of auctions. Keep it out of both the quick detail lane and chart queues.
const BROWSE = new Set(['auctions']);
const HEAVY_WORKERS = 2;

// How long a result counts as fresh. An older one (up to STALE_MS) is answered at once while a background
// query replaces it, so a dashboard view that was opened before never waits on its query again. A few
// minutes of lag is invisible next to millions of recorded auctions. Methods not listed are never cached.
const FRESH_MS = {
  overview: 60_000, turnover: 60_000, auctionAppearances: 300_000, prices: 60_000, startingPrice: 60_000,
  scatter: 60_000, categoryGroups: 120_000, categoryDetail: 60_000, timing: 120_000, players: 60_000,
  cardRankings: 300_000, card: 15_000, cards: 60_000,
};
const STALE_MS = 30 * 60_000;
const CACHE_MAX = 300;

// Query-string order and unused dashboard filters must not fragment the cache. Cards and rankings already
// receive scalar arguments; range methods receive only the fields they actually use.
const RANGE_FIELDS = ['range', 'rarity', 'shiny'];
const FILTER_FIELDS = {
  overview: RANGE_FIELDS, turnover: RANGE_FIELDS, auctionAppearances: RANGE_FIELDS,
  prices: RANGE_FIELDS, startingPrice: RANGE_FIELDS,
  scatter: [...RANGE_FIELDS, 'x'], categoryGroups: [...RANGE_FIELDS, 'mode', 'min'],
  categoryDetail: [...RANGE_FIELDS, 'mode', 'g'], timing: [...RANGE_FIELDS, 'tz'],
  players: [...RANGE_FIELDS, 'player'],
};

function normalizedArgs(method, args) {
  const fields = FILTER_FIELDS[method];
  if (!fields || !args[0] || typeof args[0] !== 'object') return args;
  const q = args[0];
  const normalized = {};
  for (const field of fields) {
    if (q[field] == null || q[field] === '') continue;
    normalized[field] = field === 'rarity' ? [...new Set(String(q[field]).split(',').filter(Boolean))].sort().join(',') : q[field];
  }
  return [normalized, ...args.slice(1)];
}

/** One worker thread and the requests sent to it. */
class WorkerSlot {
  constructor(client) {
    this.client = client;
    this.worker = null;
    this.tasks = new Map();
    this.stopping = null;
    this.activeId = null;
  }

  spawn() {
    const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { workerData: { file: this.client.file } });
    this.worker = worker;
    worker.on('message', ({ id, value, error }) => {
      if (this.worker !== worker) return;
      const task = this.tasks.get(id);
      if (!task) return;
      this.tasks.delete(id);
      clearTimeout(task.timer);
      this.activeId = null;
      if (error) task.reject(new Error(error));
      else task.resolve(value);
      this.pump();
    });
    worker.on('error', (e) => this.fail(worker, e));
    worker.on('exit', (code) => this.fail(worker, new Error(`Analysis worker exited (${code})`)));
    return worker;
  }

  fail(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    this.client.lastError = error.message;
    for (const task of this.tasks.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    this.tasks.clear();
    this.activeId = null;
    // A timeout must stop the old query before a later request starts a replacement worker.
    this.stopping = worker.terminate();
    if (!this.client.closed) this.client.log(`analysis worker stopped: ${error.message}; the next request will restart it`);
  }

  run(method, args, background = false) {
    const id = ++this.client.nextId;
    let task;
    const promise = new Promise((resolve, reject) => { task = { resolve, reject, method, args, background }; });
    this.tasks.set(id, task);
    // A queued request has its own deadline. It must not terminate a worker running somebody else's query.
    task.timer = setTimeout(() => {
      if (!this.tasks.delete(id)) return;
      task.reject(new Error('Analysis is busy; please try again shortly'));
    }, this.client.queueTimeoutMs);
    task.timer.unref();
    this.pump();
    promise.taskId = id;
    return promise;
  }

  cancelQueued(id) {
    // An active SQLite statement finishes normally. Only work that has not started can be dropped without
    // terminating a worker or affecting other requests sharing it.
    if (this.activeId === id) return false;
    const task = this.tasks.get(id);
    if (!task) return false;
    this.tasks.delete(id);
    clearTimeout(task.timer);
    task.reject(new Error('Analysis request cancelled'));
    return true;
  }

  pump() {
    if (this.activeId != null || this.client.closed || !this.tasks.size) return;
    // Foreground page requests take precedence over stale-cache and diagnostic refreshes.
    const entries = [...this.tasks];
    const [id, task] = entries.find(([, pending]) => !pending.background) ?? entries[0];
    this.activeId = id;
    clearTimeout(task.timer);
    this.dispatch(id, task.method, task.args).catch((error) => {
      if (!this.tasks.delete(id)) return;
      clearTimeout(task.timer);
      this.activeId = null;
      task.reject(error);
      this.pump();
    });
  }

  async dispatch(id, method, args) {
    await this.stopping;
    if (this.client.closed) throw new Error('Analysis worker is closed');
    if (!this.tasks.has(id)) return;
    const worker = this.worker ?? this.spawn();
    const task = this.tasks.get(id);
    task.timer = setTimeout(() => this.fail(worker, new Error('Analysis request timed out')), this.client.timeoutMs);
    task.timer.unref();
    worker.postMessage({ id, method, args });
  }

  close(error) {
    if (this.worker) this.fail(this.worker, error);
    // Also reject requests waiting for an old worker to terminate.
    for (const task of this.tasks.values()) task.reject(error);
    for (const task of this.tasks.values()) clearTimeout(task.timer);
    this.tasks.clear();
    this.activeId = null;
  }
}

/** Async bridge to the analysis workers. The collector remains the database's only writer. */
export class AnalysisClient {
  constructor(file, { log = () => {}, timeoutMs = 120_000, queueTimeoutMs = 30_000, maxPending = 100 } = {}) {
    this.file = file;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.queueTimeoutMs = queueTimeoutMs;
    this.maxPending = maxPending;
    this.fast = [new WorkerSlot(this)];
    this.browse = [new WorkerSlot(this)];
    // Diagnostics have long-lived caches and must not occupy a chart worker or alternate between readers.
    this.diagnostics = [new WorkerSlot(this)];
    this.heavy = Array.from({ length: HEAVY_WORKERS }, () => new WorkerSlot(this));
    this.inflight = new Map();
    this.workItems = new Map();
    this.cache = new Map();
    this.nextId = 0;
    this.closed = false;
    this.snapshot = null;
    this.lastError = null;
  }

  async start({ waitForStatus = true } = {}) {
    const initial = this.refreshStatus();
    this.statusTimer ??= setInterval(() => {
      this.refreshStatus().catch((e) => this.log(`analysis status: ${e.message}`));
    }, 10_000);
    this.statusTimer.unref();
    if (waitForStatus) await initial;
    else initial.catch((e) => this.log(`analysis status: ${e.message}`));
    return this;
  }

  get pending() {
    return this.slots.reduce((sum, slot) => sum + slot.tasks.size, 0);
  }

  get slots() {
    return [...this.fast, ...this.browse, ...this.heavy, ...this.diagnostics];
  }

  /** The least busy worker of the lane this method runs on. */
  slotFor(method) {
    const lane = method === 'status' ? this.diagnostics : HEAVY.has(method) ? this.heavy : BROWSE.has(method) ? this.browse : this.fast;
    return lane.reduce((best, slot) => (slot.tasks.size < best.tasks.size ? slot : best));
  }

  call(method, ...args) {
    return this.callImpl(method, args, true);
  }

  /** HTTP callers can release obsolete queued work; other callers retain the usual shared promise. */
  callWithSignal(method, args, signal) {
    if (signal.aborted) return Promise.reject(new Error('Analysis request cancelled'));
    args = normalizedArgs(method, args);
    const key = JSON.stringify([method, args]);
    const work = this.callImpl(method, args, false);
    const item = this.workItems.get(key);
    if (!item || item.promise !== work) return work; // An immediate cached answer needs no subscription.
    const subscriber = {};
    item.subscribers.add(subscriber);
    return new Promise((resolve, reject) => {
      const release = () => {
        signal.removeEventListener('abort', abort);
        item.subscribers.delete(subscriber);
      };
      const abort = () => {
        release();
        if (!item.retain && !item.subscribers.size && item.slot.cancelQueued(item.id)) {
          // A replacement request need not share a promise that was just cancelled.
          if (this.inflight.get(key) === work) this.inflight.delete(key);
          if (this.workItems.get(key) === item) this.workItems.delete(key);
        }
        reject(new Error('Analysis request cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
      work.then((value) => { release(); resolve(value); }, (error) => { release(); reject(error); });
    });
  }

  callImpl(method, args, retain) {
    if (this.closed) return Promise.reject(new Error('Analysis worker is closed'));
    args = normalizedArgs(method, args);
    const key = JSON.stringify([method, args]);
    const fresh = FRESH_MS[method];
    if (fresh == null) return this.query(key, method, args, false, retain);
    const hit = this.cache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (age < fresh) return Promise.resolve(hit.value);
    const update = this.query(key, method, args, age < STALE_MS, retain);
    if (age >= STALE_MS) return update;
    update.catch((e) => this.log(`analysis refresh (${method}): ${e.message}`));
    return Promise.resolve(hit.value);
  }

  /** Run a query on a worker; identical requests already in flight share one result. */
  query(key, method, args, background = false, retain = true) {
    const existing = this.inflight.get(key);
    if (existing) {
      const item = this.workItems.get(key);
      if (item && (retain || background)) item.retain = true;
      return existing;
    }
    if (this.pending >= this.maxPending) return Promise.reject(new Error('Analysis is busy; please try again shortly'));
    const slot = this.slotFor(method);
    const work = slot.run(method, args, background);
    const promise = work.then((value) => {
      if (FRESH_MS[method] != null) this.remember(key, value);
      return value;
    }).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
      if (this.workItems.get(key)?.promise === promise) this.workItems.delete(key);
    });
    this.inflight.set(key, promise);
    this.workItems.set(key, { promise, slot, id: work.taskId, retain: retain || background, subscribers: new Set() });
    return promise;
  }

  remember(key, value) {
    this.cache.delete(key);
    this.cache.set(key, { value, at: Date.now() });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
  }

  refreshStatus() {
    // One pending refresh at most, even when a long query spans several polling intervals.
    if (this.statusRefresh) return this.statusRefresh;
    this.statusRefresh = this.query(JSON.stringify(['status', []]), 'status', [], true).then((value) => {
      this.snapshot = { ...value, updatedAt: Date.now() };
      this.lastError = null;
    }).finally(() => { this.statusRefresh = null; });
    return this.statusRefresh;
  }

  status() {
    return { ...this.snapshot, pending: this.pending, error: this.lastError };
  }

  async close() {
    this.closed = true;
    clearInterval(this.statusTimer);
    const slots = this.slots;
    for (const slot of slots) slot.close(new Error('Analysis worker is closed'));
    this.inflight.clear();
    this.workItems.clear();
    await Promise.all(slots.map((slot) => slot.stopping));
  }
}
