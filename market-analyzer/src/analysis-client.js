import { Worker } from 'node:worker_threads';

/** Async bridge to one analysis worker. The collector remains the database's only writer. */
export class AnalysisClient {
  constructor(file, { log = () => {}, timeoutMs = 120_000, maxPending = 100 } = {}) {
    this.file = file;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.pending = new Map();
    this.inflight = new Map();
    this.nextId = 0;
    this.closed = false;
    this.worker = null;
    this.snapshot = null;
    this.lastError = null;
  }

  async start() {
    await this.refreshStatus();
    this.statusTimer ??= setInterval(() => {
      this.refreshStatus().catch((e) => this.log(`analysis status: ${e.message}`));
    }, 10_000);
    this.statusTimer.unref();
    return this;
  }

  spawn() {
    const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { workerData: { file: this.file } });
    this.worker = worker;
    worker.on('message', ({ id, value, error }) => {
      if (this.worker !== worker) return;
      const task = this.pending.get(id);
      if (!task) return;
      this.pending.delete(id);
      this.inflight.delete(task.key);
      clearTimeout(task.timer);
      if (error) task.reject(new Error(error));
      else task.resolve(value);
    });
    worker.on('error', (e) => this.fail(worker, e));
    worker.on('exit', (code) => this.fail(worker, new Error(`Analysis worker exited (${code})`)));
    return worker;
  }

  fail(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    this.lastError = error.message;
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    this.pending.clear();
    this.inflight.clear();
    // A timeout must stop the old query before a later request starts a replacement worker.
    this.stopping = worker.terminate();
    if (!this.closed) this.log(`analysis worker stopped: ${error.message}; the next request will restart it`);
  }

  call(method, ...args) {
    if (this.closed) return Promise.reject(new Error('Analysis worker is closed'));
    const key = JSON.stringify([method, args]);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error('Analysis is busy; please try again shortly'));
    const id = ++this.nextId;
    let task;
    const promise = new Promise((resolve, reject) => { task = { key, resolve, reject }; });
    this.pending.set(id, task);
    this.inflight.set(key, promise);
    // Waiting for termination is asynchronous; it never delays collector timers or network callbacks.
    this.dispatch(id, method, args).catch((error) => {
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      this.inflight.delete(key);
      clearTimeout(task.timer);
      task.reject(error);
    });
    return promise;
  }

  async dispatch(id, method, args) {
    await this.stopping;
    if (this.closed || !this.pending.has(id)) return;
    const worker = this.worker ?? this.spawn();
    const task = this.pending.get(id);
    task.timer = setTimeout(() => this.fail(worker, new Error('Analysis request timed out')), this.timeoutMs);
    task.timer.unref();
    worker.postMessage({ id, method, args });
  }

  refreshStatus() {
    // One pending refresh at most, even when a long query spans several polling intervals.
    if (this.statusRefresh) return this.statusRefresh;
    this.statusRefresh = this.call('status').then((value) => {
      this.snapshot = { ...value, updatedAt: Date.now() };
      this.lastError = null;
    }).finally(() => { this.statusRefresh = null; });
    return this.statusRefresh;
  }

  status() {
    return { ...this.snapshot, pending: this.pending.size, error: this.lastError };
  }

  async close() {
    this.closed = true;
    clearInterval(this.statusTimer);
    if (this.worker) this.fail(this.worker, new Error('Analysis worker is closed'));
    // Also reject requests waiting for an old worker to terminate.
    for (const task of this.pending.values()) task.reject(new Error('Analysis worker is closed'));
    this.pending.clear();
    this.inflight.clear();
    await this.stopping;
  }
}
