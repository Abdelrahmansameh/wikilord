// Watches new listings and ending-soon auctions, then stores one final result per auction ID.
//
//  1. Sweep: every pollMs, page through sort=ending_soon until the list reaches coverSec into the future,
//     saving each auction's latest snapshot and remembering its end time.
//  2. Settle: settleDelayMs after an auction's end, fetch /api/marketplace/:id for the outcome and full bid
//     history. Still active (not settled yet, or extended by a late bid) -> try again later.
//
// Both account sessions share one pending-ID map and one SQLite writer, but each has its own request budget.

const LIST_PATH = (sort, page) => `/api/marketplace?page=${page}&limit=50&sort=${sort}`;

/** Per-minute counters for the last hour, for the dashboard's health panel. */
class Meter {
  constructor() {
    this.buckets = new Map();
  }

  add(key, by = 1) {
    const m = Math.floor(Date.now() / 60000);
    let b = this.buckets.get(m);
    if (!b) {
      b = {};
      this.buckets.set(m, b);
      for (const k of this.buckets.keys()) if (k < m - 60) this.buckets.delete(k);
    }
    b[key] = (b[key] ?? 0) + by;
  }

  /** Totals over the last `minutes` complete-or-current minutes. */
  sum(minutes) {
    const from = Math.floor(Date.now() / 60000) - minutes + 1;
    const out = {};
    for (const [m, b] of this.buckets) if (m >= from) for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
    return out;
  }

  series() {
    const now = Math.floor(Date.now() / 60000);
    const out = [];
    for (let m = now - 59; m <= now; m++) out.push({ t: m * 60000, ...(this.buckets.get(m) ?? {}) });
    return out;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Collector {
  constructor(store, pool, cfg, log) {
    this.store = store;
    this.pool = pool;
    this.cfg = cfg;
    this.log = log;
    this.meter = new Meter();
    this.pending = new Map(); // auction id -> { due, tries }
    this.inflight = 0;
    this.lastError = null;
    this.coveredUntil = 0; // end time reached by the previous sweep
    this.uncoveredMs = 0; // time windows a sweep could not reach in time (auctions there may be missed)
    this.lastSweep = null;
    this.lastRecentSweep = null;
    this.recentWatermark = Number(store.getMeta('recent_watermark_ms')) || Date.now() - cfg.recentInitialLookbackSec * 1000;
    this.recentHead = Number(store.getMeta('recent_head_ms')) || null;
    try { this.recentCursor = JSON.parse(store.getMeta('recent_cursor')) || { page: 2, oldest: null }; }
    catch { this.recentCursor = { page: 2, oldest: null }; }
    if (!Number.isInteger(this.recentCursor.page) || this.recentCursor.page < 2)
      this.recentCursor = { page: 2, oldest: null };
    this.lastPendingRefresh = 0;
    this.startedAt = Date.now();
    this.stopped = false;
  }

  start() {
    this.refreshPending();
    if (this.pending.size) this.log(`resuming: ${this.pending.size} auctions waiting for their result`);
    this.sweepLoop();
    this.recentLoop();
    this.settleTimer = setInterval(() => this.dispatch(), 250);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.settleTimer);
  }

  /** Called after a new cookie is pasted on the dashboard. */
  resume(slot = 'primary') {
    this.pool.resume(slot);
    this.lastError = null;
  }

  async get(path, priority) {
    return this.pool.request(path, priority, (slot) => {
      this.meter.add('requests');
      this.meter.add(`requests_${slot}`);
    });
  }

  fail(e) {
    this.meter.add('errors');
    if (this.lastError?.message !== e.message) this.log(`error: ${e.message}`);
    this.lastError = { message: e.message, at: Date.now() };
  }

  async sweepLoop() {
    while (!this.stopped) {
      const t0 = Date.now();
      if (!this.pool.activeCount) {
        await sleep(2000);
        continue;
      }
      try {
        await this.sweep();
      } catch (e) {
        this.fail(e);
        await sleep(2000);
      }
      await sleep(Math.max(0, this.cfg.pollMs - (Date.now() - t0)));
    }
  }

  async sweep() {
    const start = Date.now();
    const want = start + this.cfg.coverSec * 1000;
    let reached = 0;
    let pages = 0;
    let fresh = 0;
    for (let page = 1; page <= this.cfg.maxPagesPerCycle; page++) {
      const r = await this.get(LIST_PATH('ending_soon', page), 0);
      const list = r.json?.auctions;
      if (r.status !== 200 || !Array.isArray(list)) throw new Error(`marketplace list: HTTP ${r.status}`);
      pages++;
      const saved = this.store.saveSnapshots(list, 'ending');
      this.schedule(saved.pending);
      fresh += saved.fresh;
      if (saved.conflicts) this.meter.add('conflicts', saved.conflicts);
      for (const a of list) {
        const end = Date.parse(a.end_at);
        if (end > reached) reached = end;
      }
      if (!r.json.hasMore) {
        reached = Math.max(reached, want); // the whole list was seen: nothing else can end before `want`
        break;
      }
      if (reached >= want) break;
    }
    // Anything that ended between the previous sweep's reach and now may have settled unseen.
    if (this.coveredUntil && this.coveredUntil < start - 1000) {
      this.uncoveredMs += start - this.coveredUntil;
      this.meter.add('uncoveredSec', (start - this.coveredUntil) / 1000);
    }
    this.coveredUntil = Math.max(this.coveredUntil, reached);
    this.meter.add('discovered', fresh);
    this.meter.add('listPages', pages);
    this.lastSweep = { at: start, pages, fresh, aheadSec: Math.round((reached - start) / 1000), ms: Date.now() - start };
  }

  schedule(rows) {
    const horizon = Date.now() + this.cfg.pendingHorizonSec * 1000;
    for (const a of rows) {
      if (a.end_at == null || a.end_at > horizon) continue;
      const due = a.status === 'active' ? a.end_at + this.cfg.settleDelayMs : Date.now();
      const p = this.pending.get(a.id);
      if (p) p.due = Math.max(p.due, due); // a late bid may have extended the end
      else this.pending.set(a.id, { due, tries: 0 });
    }
  }

  /** Bring long-lived listings into memory only when their end is near. */
  refreshPending() {
    const now = Date.now();
    this.lastPendingRefresh = now;
    for (const p of this.store.pending(now + this.cfg.pendingHorizonSec * 1000))
      if (!this.pending.has(p.id)) this.pending.set(p.id, {
        due: Math.max(now, (p.end_at ?? 0) + this.cfg.settleDelayMs), tries: p.detail_tries,
      });
  }

  async recentLoop() {
    while (!this.stopped) {
      const t0 = Date.now();
      if (!this.pool.activeCount) { await sleep(2000); continue; }
      try { await this.sweepRecent(); }
      catch (e) { this.fail(e); await sleep(2000); }
      await sleep(Math.max(0, this.cfg.recentPollMs - (Date.now() - t0)));
    }
  }

  async recentPage(page, priority) {
    const r = await this.get(LIST_PATH('recent', page), priority);
    const list = r.json?.auctions;
    if (r.status !== 200 || !Array.isArray(list)) throw new Error(`recent listings page ${page}: HTTP ${r.status}`);
    for (let i = 0; i < list.length; i++) {
      if (!Number.isFinite(Date.parse(list[i].created_at))) throw new Error('recent listing has no valid creation time');
      if (i && Date.parse(list[i].created_at) > Date.parse(list[i - 1].created_at))
        throw new Error('recent listings are not sorted newest first; refusing to advance watermark');
    }
    return { list, hasMore: Boolean(r.json.hasMore) };
  }

  /** Page newest-first to the last completed watermark, including overlap across restarts. */
  async sweepRecent() {
    const start = Date.now();
    const pageBudget = Math.max(3, this.cfg.maxRecentPagesPerCycle);
    const overlapMs = this.cfg.recentOverlapSec * 1000;
    const target = this.recentWatermark - overlapMs;
    const headTarget = this.recentHead == null ? null : this.recentHead - overlapMs;
    let pages = 0, fresh = 0, oldest = Infinity;
    const first = await this.recentPage(1, 0);
    pages++;
    const newest = first.list.length ? Date.parse(first.list[0].created_at) : this.recentWatermark;
    const ingest = (result) => {
      const saved = this.store.saveSnapshots(result.list, 'recent');
      this.schedule(saved.pending);
      fresh += saved.fresh;
      if (saved.conflicts) this.meter.add('conflicts', saved.conflicts);
      if (result.list.length) oldest = Math.min(oldest, Date.parse(result.list.at(-1).created_at));
    };
    ingest(first);
    // Always bridge the front of the feed back to the previous head before jumping to a
    // deep catch-up cursor. Otherwise >50 new listings between cycles can be skipped.
    let headComplete = headTarget == null || !first.hasMore || oldest <= headTarget;
    let headPage = 2;
    let lastHeadResult = first;
    while (!headComplete && pages < pageBudget) {
      lastHeadResult = await this.recentPage(headPage++, 2);
      pages++;
      ingest(lastHeadResult);
      headComplete = !lastHeadResult.hasMore || oldest <= headTarget;
    }
    if (headComplete) this.recentHead = Math.max(this.recentHead ?? 0, newest);
    let complete = headComplete && (!lastHeadResult.hasMore || oldest <= target);
    let page = Math.max(headPage, this.recentCursor.page - 1);
    let tailPages = 0;
    let overlapFound = this.recentCursor.oldest == null;
    let rewindCount = 0;
    while (headComplete && !complete && pages < pageBudget) {
      const result = await this.recentPage(page, 2);
      pages++;
      if (!overlapFound && result.list.length && Date.parse(result.list[0].created_at) < this.recentCursor.oldest) {
        // Listings vanished from the offset pages; rewind until the previous page boundary overlaps.
        if (page <= 2 || ++rewindCount > pageBudget / 2)
          throw new Error('recent pagination skipped a page; watermark held for retry');
        page = Math.max(2, page - 2);
        continue;
      }
      overlapFound = true;
      ingest(result);
      tailPages++;
      complete = !result.hasMore || oldest <= target;
      page++;
    }
    if (complete) {
      this.recentWatermark = Math.max(this.recentWatermark, newest);
      this.recentCursor = { page: 2, oldest: null };
    } else if (tailPages) this.recentCursor = {
      page, oldest: Math.min(this.recentCursor.oldest ?? Infinity, oldest),
    };
    this.store.setRecentProgress(this.recentWatermark, this.recentCursor, this.recentHead ?? 0);
    this.meter.add('recentPages', pages);
    this.meter.add('recentListings', fresh);
    this.lastRecentSweep = { at: start, pages, fresh, complete, lagSec: Math.max(0, Math.round((Date.now() - this.recentWatermark) / 1000)),
      cursorPage: this.recentCursor.page, ms: Date.now() - start };
  }

  dispatch() {
    if (!this.pool.activeCount || this.stopped) return;
    const now = Date.now();
    if (now - this.lastPendingRefresh > 10_000) this.refreshPending();
    const room = this.cfg.maxInflight * this.pool.activeCount - this.inflight;
    if (room <= 0) return;
    const due = [];
    for (const [id, p] of this.pending) if (p.due <= now && !p.busy) due.push([id, p]);
    due.sort((a, b) => a[1].due - b[1].due);
    for (const [id, p] of due.slice(0, room)) this.settle(id, p);
  }

  async settle(id, p) {
    p.busy = true;
    this.inflight++;
    try {
      const r = await this.get(`/api/marketplace/${id}`, 1);
      if (r.status === 404) {
        // Listings may disappear briefly around settlement. Keep retrying; never mark an unknown result final.
        p.tries++;
        this.store.markTried(id);
        p.due = Date.now() + Math.min(300_000, 2000 * 2 ** Math.min(p.tries, 8));
        this.meter.add('missingDetail');
        return;
      }
      const a = r.json?.auction;
      if (r.status !== 200 || !a) throw new Error(`auction ${id}: HTTP ${r.status}`);
      if (a.status === 'active') {
        // Not settled yet, or a late bid pushed the end back: come back after the (new) end.
        const end = Date.parse(a.end_at);
        p.tries++;
        this.store.markTried(id, end);
        p.due = Math.max(end + this.cfg.settleDelayMs, Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(p.tries, 6)));
        this.meter.add('notYet');
        return;
      }
      const saved = this.store.saveResult(r.json, this.cfg.keepRaw, r.account);
      if (saved.conflict && !saved.duplicate && saved.retry !== false) {
        this.meter.add('conflicts');
        p.tries++;
        p.due = Date.now() + 300_000;
        return;
      }
      this.pending.delete(id);
      if (saved.stored) {
        if (a.status === 'cancelled') this.meter.add('cancelled');
        else {
          this.meter.add('settled');
          this.meter.add(a.status === 'settled_sold' ? 'sold' : 'unsold');
        }
      } else this.meter.add('duplicates');
    } catch (e) {
      this.fail(e);
      p.tries++;
      this.store.markTried(id);
      p.due = Date.now() + Math.min(300_000, 2000 * 2 ** Math.min(p.tries, 8));
    } finally {
      p.busy = false;
      this.inflight--;
    }
  }

  status() {
    const now = Date.now();
    let overdue = 0;
    for (const p of this.pending.values()) if (p.due <= now) overdue++;
    return {
      startedAt: this.startedAt,
      needsLogin: !this.pool.activeCount,
      accounts: this.pool.status(),
      lastError: this.lastError,
      lastSweep: this.lastSweep,
      lastRecentSweep: this.lastRecentSweep,
      recentLagSec: Math.max(0, Math.round((now - this.recentWatermark) / 1000)),
      pending: this.pending.size,
      overdue,
      inflight: this.inflight,
      queued: this.pool.waiting,
      slowedDown: this.pool.slowedDown,
      uncoveredSec: Math.round(this.uncoveredMs / 1000),
      last5min: this.meter.sum(5),
      lastHour: this.meter.sum(60),
      series: this.meter.series(),
    };
  }
}
