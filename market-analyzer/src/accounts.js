// One request budget and login state per account. Both feed the same collector and SQLite writer.
class Limiter {
  constructor(rps) {
    this.rps = rps;
    this.queues = [[], [], []]; // urgent lists, result lookups, then recent-list catch-up
    this.next = 0;
    this.timer = null;
    this.slowUntil = 0;
    this.turn = 0;
    this.pattern = [0, 1, 1, 0, 1, 1, 0, 1, 2, 1];
  }

  get rate() {
    return Date.now() < this.slowUntil ? Math.max(0.5, this.rps / 4) : this.rps;
  }

  get waiting() {
    return this.queues.reduce((n, q) => n + q.length, 0);
  }

  get delay() {
    return Math.max(0, this.next - Date.now()) + this.waiting * 1000 / this.rate;
  }

  take(priority) {
    return new Promise((resolve) => {
      this.queues[priority].push(resolve);
      this.pump();
    });
  }

  pump() {
    if (this.timer || !this.waiting) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.next = Date.now() + 1000 / this.rate;
      // A busy result backlog must not starve recent-listing catch-up.
      let queue = null;
      for (let i = 0; i < this.pattern.length; i++) {
        const candidate = this.pattern[this.turn++ % this.pattern.length];
        if (this.queues[candidate].length) { queue = this.queues[candidate]; break; }
      }
      (queue ?? this.queues.find((q) => q.length)).shift()();
      this.pump();
    }, Math.max(0, this.next - Date.now()));
  }

  backOff() {
    this.slowUntil = Date.now() + 60_000;
  }
}

export class AccountPool {
  constructor(sessions, cfg, log) {
    this.accounts = sessions.map((session, i) => ({
      slot: i ? 'secondary' : 'primary', session, limiter: new Limiter(cfg.maxRps),
      needsLogin: false, blockedReason: null, inflight: 0, requests: 0, lastError: null,
    }));
    this.log = log;
    this.cursor = 0;
    this.checkDistinct();
  }

  checkDistinct() {
    const [a, b] = this.accounts;
    b.blockedReason = a.session.userId() && a.session.userId() === b.session.userId()
      ? 'same player as account 1; use a different account' : null;
  }

  canUse(a) {
    return a.session.hasCookie() && !a.needsLogin && !a.blockedReason;
  }

  get activeCount() {
    return this.accounts.filter((a) => this.canUse(a)).length;
  }

  get waiting() {
    return this.accounts.reduce((n, a) => n + a.limiter.waiting, 0);
  }

  get slowedDown() {
    return this.accounts.some((a) => Date.now() < a.limiter.slowUntil);
  }

  resume(slot) {
    const a = this.accounts.find((x) => x.slot === slot);
    if (!a) throw new Error('unknown account slot');
    a.needsLogin = false;
    a.lastError = null;
    this.checkDistinct();
  }

  /** Prefer the account with the earliest available request slot; ties alternate. */
  choose(excluded = new Set()) {
    const choices = this.accounts.filter((a) => this.canUse(a) && !excluded.has(a.slot));
    if (!choices.length) return null;
    const rotated = [...choices.slice(this.cursor % choices.length), ...choices.slice(0, this.cursor % choices.length)];
    this.cursor++;
    return rotated.sort((a, b) => a.limiter.delay - b.limiter.delay)[0];
  }

  /** Retry once through the other account on auth failure or server pushback. */
  async request(path, priority, onRequest = () => {}) {
    const tried = new Set();
    let lastError;
    for (;;) {
      const a = this.choose(tried);
      if (!a) throw lastError ?? Object.assign(new Error('no logged-in market account'), { needsLogin: true });
      tried.add(a.slot);
      await a.limiter.take(priority);
      if (!this.canUse(a)) continue;
      a.inflight++;
      a.requests++;
      onRequest(a.slot);
      try {
        const r = await a.session.request('GET', path);
        const authFailure = r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400 && /login/i.test(r.location ?? ''));
        if (authFailure) {
          a.needsLogin = true;
          lastError = new Error(`${a.slot} account needs a fresh cookie (HTTP ${r.status})`);
          a.lastError = lastError.message;
          this.log(lastError.message);
          continue;
        }
        if (r.status === 429 || r.status >= 500) {
          a.limiter.backOff();
          lastError = new Error(`${a.slot} account got HTTP ${r.status}; slowing it down`);
          a.lastError = lastError.message;
          continue;
        }
        return { ...r, account: a.slot };
      } catch (e) {
        lastError = e;
        a.lastError = e.message;
        if (e.needsLogin) {
          a.needsLogin = true;
          this.log(`${a.slot} account needs a fresh cookie`);
          continue;
        }
        // A timeout is usually shared network trouble; let the caller retry later.
        throw e;
      } finally {
        a.inflight--;
      }
    }
  }

  status() {
    return this.accounts.map((a) => ({ slot: a.slot, username: a.session.username(), hasCookie: a.session.hasCookie(),
      needsLogin: a.needsLogin, blockedReason: a.blockedReason, inflight: a.inflight,
      queued: a.limiter.waiting, slowedDown: Date.now() < a.limiter.slowUntil,
      requests: a.requests, lastError: a.lastError, refreshWarning: a.session.refreshWarning ?? null }));
  }
}
