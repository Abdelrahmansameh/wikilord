// Read-only status page for both bots, meant to be opened from a phone through Tailscale.
//
// It never talks to wiki-masters.com and has no way to change anything: it only GETs a few endpoints from the two
// local dashboards and passes on a whitelisted subset (no cookies, no config, no card ids). It listens on 127.0.0.1;
// `tailscale serve` is what makes it reachable, and only from devices signed in to your tailnet.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.VIEWER_PORT) || 8790;
const BOT = process.env.VIEWER_BOT_URL || 'http://127.0.0.1:8787';
const MARKET = process.env.VIEWER_MARKET_URL || 'http://127.0.0.1:8788';
// Optional: only these Tailscale logins may look (comma separated). Empty = anyone on your tailnet.
const ALLOW = (process.env.VIEWER_ALLOW || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const FILES = {
  '/': ['page.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const get = async (base, path) => {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const tryGet = (base, path) => get(base, path).then((data) => ({ data }), (e) => ({ error: e.name === 'TimeoutError' ? 'not answering' : e.cause?.code === 'ECONNREFUSED' ? 'not running' : e.message }));

// Belt and braces: the bot's log should never hold a token, but strip anything that looks like one.
const scrub = (s) => String(s).replace(/sb-[\w-]*-auth-token[^\s]*/gi, '[redacted]').replace(/eyJ[\w-]{10,}\.[\w-]{10,}(\.[\w-]+)?/g, '[redacted]');

async function botSummary() {
  const [state, report] = await Promise.all([tryGet(BOT, '/api/state'), tryGet(BOT, '/api/report')]);
  if (state.error) return { online: false, error: state.error };
  const s = state.data;
  const r = report.data;
  return {
    online: true,
    mode: s.mode, connected: s.connected, sessionProblem: s.sessionProblem, paused: s.paused, uptimeSec: s.uptimeSec,
    balance: s.balance, sessionMinLeft: s.sessionMinLeft, wishlistSize: s.wishlistSize,
    money: s.money, spentToday: s.spentToday, dailySpendCap: s.dailySpendCap,
    stats: { packs: s.stats?.packs, recycled: s.stats?.recycled, bidsOk: s.stats?.bidsOk, bidsFailed: s.stats?.bidsFailed },
    scan: s.scan && { running: s.scan.running, lastAt: s.scan.lastAt, summary: s.scan.summary, everySec: s.scan.everySec },
    plans: (s.plans ?? []).slice(0, 25).map(({ title, rarity, amount, rule, fireInSec }) => ({ title, rarity, amount, rule, fireInSec })),
    recentBids: (s.recentBids ?? []).slice(0, 10).map(({ at, title, rarity, amount, status, counter }) => ({ at, title, rarity, amount, ok: status === 200, counter })),
    log: (s.log ?? []).slice(-40).map(scrub),
    report: r && {
      spend: r.spend,
      collection: r.collection,
      themes: (r.themes ?? []).map(({ name, enabled, weeklyBudget, spent7d, held, left, targets, owned }) => ({ name, enabled, weeklyBudget, spent7d, held, left, targets, owned })),
      won7d: r.last7days?.won, lost7d: r.last7days?.lost,
      results: (r.last7days?.events ?? []).slice(0, 15).map(({ at, type, title, rarity, price, theme }) => ({ at, type, title, rarity, price, theme })),
      watching: (r.targets ?? []).filter((t) => t.auction && !t.owned)
        .map((t) => ({ title: t.title, rarity: t.rarity, theme: t.theme, maxBid: t.effectiveMaxBid, price: t.auction.price, endsAt: t.auction.endsAt, leading: t.auction.leading, planned: t.auction.planned }))
        .sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt)).slice(0, 15),
    },
  };
}

async function marketSummary() {
  const [status, day] = await Promise.all([tryGet(MARKET, '/api/status'), tryGet(MARKET, '/api/overview?range=24h')]);
  if (status.error) return { online: false, error: status.error };
  const s = status.data;
  const c = s.collector ?? {};
  const pick = (m = {}) => ({ requests: m.requests, settled: m.settled, sold: m.sold, discovered: m.discovered });
  return {
    online: true,
    accounts: (s.accounts ?? []).map(({ slot, username, hasCookie, needsLogin, blockedReason, slowedDown, lastError, refreshWarning }) =>
      ({ slot, username, hasCookie, needsLogin, blockedReason, slowedDown, lastError, refreshWarning })),
    collector: {
      startedAt: c.startedAt, needsLogin: c.needsLogin, lastError: c.lastError, lastSweepAt: c.lastSweep?.at, lastRecentSweepAt: c.lastRecentSweep?.at,
      recentLagSec: c.recentLagSec, pending: c.pending, overdue: c.overdue, slowedDown: c.slowedDown, uncoveredSec: c.uncoveredSec,
      last5min: pick(c.last5min), lastHour: pick(c.lastHour),
      perMinute: (c.series ?? []).map((b) => ({ t: b.t, settled: b.settled ?? 0, requests: b.requests ?? 0 })),
    },
    db: s.db && { auctions: s.db.auctions, settled: s.db.settled, open: s.db.open, bytes: s.db.bytes, oldest: s.db.oldest },
    day: day.data?.totals ?? null,
  };
}

// One shared answer every few seconds, however many tabs are open.
let cache = { at: 0, body: null };
async function summary() {
  if (Date.now() - cache.at < 3000 && cache.body) return cache.body;
  const [bot, market] = await Promise.all([botSummary(), marketSummary()]);
  cache = { at: Date.now(), body: JSON.stringify({ at: new Date().toISOString(), bot, market }) };
  return cache.body;
}

const SECURITY = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, ...SECURITY });
    res.end(body);
  };
  try {
    // Reached directly on this PC, or through `tailscale serve` (which sends the *.ts.net name). Anything else is
    // some other site trying to read this page from your browser.
    const host = (req.headers.host ?? '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) && !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(host)) return send(403, '{"error":"forbidden host"}');
    if (ALLOW.length && !ALLOW.includes(String(req.headers['tailscale-user-login'] ?? '').toLowerCase())) return send(403, '{"error":"not allowed"}');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, '{"error":"read only"}');

    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/api/summary') return send(200, await summary());
    const file = FILES[path];
    if (file) return send(200, fs.readFileSync(new URL(file[0], import.meta.url)), file[1]);
    send(404, '{"error":"not found"}');
  } catch (e) {
    send(500, JSON.stringify({ error: e.message }));
  }
});
server.on('error', (e) => (console.error(`viewer could not start: ${e.message}`), process.exit(1)));
server.listen(PORT, '127.0.0.1', () => console.log(`read-only viewer: http://localhost:${PORT}  (bot ${BOT}, market ${MARKET})`));
