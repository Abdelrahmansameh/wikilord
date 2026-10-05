// Status page for both bots, meant to be opened from a phone through Tailscale.
//
// It never talks to wiki-masters.com and can change only one thing: a bot's login cookie (passed to that bot's own
// Connect endpoint, which checks it against the site). Otherwise it only GETs a few endpoints from the two local
// dashboards and passes on a whitelisted subset (no cookies, no config, no card ids). It listens on 127.0.0.1;
// `tailscale serve` is what makes it reachable, and only from devices signed in to your tailnet.
import http from 'node:http';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { startTelegramNotifications } from './telegram-notifications.js';

const PORT = Number(process.env.VIEWER_PORT) || 8790;
const BOT = process.env.VIEWER_BOT_URL || 'http://127.0.0.1:8787';
const MARKET = process.env.VIEWER_MARKET_URL || 'http://127.0.0.1:8788';
const MONEY = process.env.VIEWER_MONEY_URL || 'http://127.0.0.1:8789';
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
    packs: { blocked: s.packs?.blocked ?? null }, bidHumanCheck: s.bidHumanCheck ?? null,
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
    accounts: (s.accounts ?? []).map(({ slot, username, hasCookie, needsLogin, blockedReason, slowedDown, refreshWarning }) =>
      ({ slot, username, hasCookie, needsLogin, blockedReason, slowedDown, refreshWarning })),
    collector: {
      startedAt: c.startedAt, needsLogin: c.needsLogin, lastError: c.lastError && { message: c.lastError.message ?? String(c.lastError), at: c.lastError.at }, lastSweepAt: c.lastSweep?.at, lastRecentSweepAt: c.lastRecentSweep?.at,
      recentLagSec: c.recentLagSec, pending: c.pending, overdue: c.overdue, slowedDown: c.slowedDown, uncoveredSec: c.uncoveredSec,
      last5min: pick(c.last5min), lastHour: pick(c.lastHour),
      perMinute: (c.series ?? []).map((b) => ({ t: b.t, settled: b.settled ?? 0, requests: b.requests ?? 0 })),
    },
    db: s.db && { auctions: s.db.auctions, settled: s.db.settled, open: s.db.open, bytes: s.db.bytes, oldest: s.db.oldest },
    day: day.data?.totals ?? null,
  };
}

async function moneySummary(path = '/api/state') {
  const result = await tryGet(MONEY, path);
  if (result.error) return { online: false, error: result.error };
  const s = result.data;
  return {
    online: true, mode: s.mode, connected: s.connected, account: s.account, paused: s.paused,
    balance: s.balance, net: s.net, lastCycleAt: s.lastCycleAt, lastError: s.lastError,
    problem: s.problem,
    humanVerification: s.humanVerification ? { method: s.humanVerification.method, path: s.humanVerification.path,
      status: s.humanVerification.status, detail: s.humanVerification.detail,
      detectedAt: s.humanVerification.detectedAt } : null,
    humanVerifications: (s.humanVerifications ?? []).map(({ method, path, status, detail, detectedAt }) =>
      ({ method, path, status, detail, detectedAt })),
    packs: { blocked: s.packs?.blocked ?? null },
    slots: s.slots && { active: s.slots.active, max: s.slots.max, free: s.slots.free },
    cutoff: s.cutoff?.value, stats: s.stats && {
      opened: s.stats.opened, listed: s.stats.listed, sold: s.stats.sold,
      salesRevenue: s.stats.salesRevenue, recycled: s.stats.recycled, recycleRevenue: s.stats.recycleRevenue,
    },
    queued: (s.decisions ?? []).filter((d) => d.action === 'queue').length,
    deals: s.deals && { planned: s.deals.plans?.length ?? 0,
      heldBidAmount: s.deals.heldBidAmount ?? 0, reserve: s.deals.reserve ?? null },
    resaleProfit: s.accounting?.resaleProfit ?? 0,
  };
}

// One shared answer every few seconds, however many tabs are open.
let cache = { at: 0, body: null };
async function summary() {
  if (Date.now() - cache.at < 3000 && cache.body) return cache.body;
  const [bot, market, money, premiumMoney] = await Promise.all([
    botSummary(), marketSummary(), moneySummary(), moneySummary('/api/premium/state')]);
  cache = { at: Date.now(), body: JSON.stringify({ at: new Date().toISOString(), bot, market, money, premiumMoney }) };
  return cache.body;
}

const SECURITY = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

// Reached directly on this PC, or through `tailscale serve` (which sends the *.ts.net name). Anything else is some other
// site trying to read these pages from your browser. Only GET, except the one route given in `write`: pasting a login
// cookie. That one must also come from our own page (same Origin, JSON body) and, through Tailscale, from the owner of
// this PC's Tailscale account (tailscale serve adds Tailscale-User-Login; see `owners` below).
function refuse(req, write) {
  const host = (req.headers.host ?? '').toLowerCase();
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  if (!local && !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(:\d+)?$/.test(host)) return [403, 'forbidden host'];
  const login = String(req.headers['tailscale-user-login'] ?? '').toLowerCase();
  if (ALLOW.length && !ALLOW.includes(login)) return [403, 'not allowed'];
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== write) return [405, 'read only'];
  if (req.headers.origin !== `${local ? 'http' : 'https'}://${host}`) return [403, 'forbidden origin'];
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return [415, 'send JSON'];
  if (!local && !owners.includes(login)) return [403, "only the owner of this PC's Tailscale account can do this"];
  return null;
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => ((s += c), s.length > 64_000 && (reject(new Error('too large')), req.destroy())));
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });

// Who pasted it, for the console. Never the cookie itself.
const who = (req) => req.headers['tailscale-user-login'] ?? 'this PC';

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, ...SECURITY });
    res.end(body);
  };
  try {
    const no = refuse(req, '/api/bot-cookie');
    if (no) return send(no[0], JSON.stringify({ error: no[1] }));
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/api/summary') return send(200, await summary());
    // New login for the trading bot, passed to its own Connect endpoint (which checks it against the site first).
    if (req.method === 'POST' && path === '/api/bot-cookie') {
      const { cookie } = JSON.parse((await readBody(req)) || '{}');
      if (typeof cookie !== 'string' || !cookie.trim()) return send(400, '{"error":"Paste the cookie first."}');
      const r = await fetch(BOT + '/api/cookie', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-ui': '1' }, body: JSON.stringify({ cookie }), signal: AbortSignal.timeout(30_000),
      });
      const out = await r.json().catch(() => ({ error: `the bot answered HTTP ${r.status}` }));
      console.log(`${new Date().toISOString()} bot cookie from ${who(req)}: ${r.ok ? 'accepted' : 'rejected'}`);
      cache.at = 0;
      return send(r.status, JSON.stringify(out));
    }
    // The full dashboards live on their own ports (see below); send the phone to the matching address.
    if (path === '/market' || path === '/full' || path === '/money' || path === '/money-premium') {
      const host = (req.headers.host ?? '').split(':')[0];
      const [ts, lp] = path === '/market' ? [MARKET_TS_PORT, MARKET_PORT]
        : path === '/money' || path === '/money-premium' ? [MONEY_TS_PORT, MONEY_PORT] : [FULL_TS_PORT, FULL_PORT];
      const destination = path === '/money-premium' ? '/premium' : '/';
      const to = host.endsWith('.ts.net') ? `https://${host}:${ts}${destination}` : `http://localhost:${lp}${destination}`;
      res.writeHead(302, { location: to, ...SECURITY });
      return res.end();
    }
    const file = FILES[path];
    if (file) return send(200, fs.readFileSync(new URL(file[0], import.meta.url)), file[1]);
    send(404, '{"error":"not found"}');
  } catch (e) {
    send(e.cause?.code === 'ECONNREFUSED' ? 502 : 500, JSON.stringify({ error: e.cause?.code === 'ECONNREFUSED' ? 'The bot is not running on the PC.' : e.message }));
  }
});
server.on('error', (e) => (console.error(`viewer could not start: ${e.message}`), process.exit(1)));
server.listen(PORT, '127.0.0.1', () => {
  console.log(`read-only viewer: http://localhost:${PORT}  (bot ${BOT}, market ${MARKET})`);
  startTelegramNotifications(summary);
});

// The market analyzer's own dashboard, passed through as-is. GET only, plus its one write: pasting a login cookie on the
// Collector tab (checked by refuse() like the bot's). A strip at the top says so. It needs its own port because the
// page asks for /api/... at the root.
const MARKET_PORT = Number(process.env.VIEWER_MARKET_PORT) || 8791;
const MARKET_TS_PORT = Number(process.env.VIEWER_MARKET_TS_PORT) || 8443;
const MARKET_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const READ_ONLY = `<style>#ro-strip { background: #3a2a10; color: #f2b14c; font: 600 12px system-ui, sans-serif; text-align: center; padding: 4px 8px; }
#ro-strip a { color: inherit; }</style>`;

const marketServer = http.createServer(async (req, res) => {
  const send = (code, body, type, csp = SECURITY['content-security-policy']) => {
    res.writeHead(code, { 'content-type': type, ...SECURITY, 'content-security-policy': csp });
    res.end(body);
  };
  try {
    const no = refuse(req, '/api/cookie');
    if (no) return send(no[0], JSON.stringify({ error: no[1] }), 'application/json');
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST') {
      const r = await fetch(MARKET + '/api/cookie', { method: 'POST', headers: { 'content-type': 'application/json' }, body: await readBody(req), signal: AbortSignal.timeout(30_000) });
      const out = await r.text();
      console.log(`${new Date().toISOString()} market cookie from ${who(req)}: ${/"ok":true/.test(out) ? 'accepted' : 'rejected'}`);
      cache.at = 0;
      return send(r.status, out, 'application/json');
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const r = await fetch(MARKET + '/', { signal: AbortSignal.timeout(5000) });
      const back = (req.headers.host ?? '').split(':')[0].endsWith('.ts.net') ? `https://${(req.headers.host ?? '').split(':')[0]}/` : `http://localhost:${PORT}/`;
      const html = (await r.text())
        .replace('</head>', READ_ONLY + '</head>')
        .replace(/<body([^>]*)>/, `<body$1><div id="ro-strip">Remote view: read-only, except pasting a login cookie on the Collector tab · <a href="${back}">back to status</a></div>`);
      return send(r.status, html, 'text/html; charset=utf-8', MARKET_CSP);
    }
    if (!url.pathname.startsWith('/api/')) return send(404, '{"error":"not found"}', 'application/json');
    const r = await fetch(MARKET + url.pathname + url.search, { signal: AbortSignal.timeout(30_000) });
    send(r.status, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') ?? 'application/json');
  } catch (e) {
    const down = e.cause?.code === 'ECONNREFUSED';
    send(502, down ? 'The market analyzer is not running on the PC.' : `Could not reach the market analyzer: ${e.message}`, 'text/plain; charset=utf-8');
  }
});
marketServer.on('error', (e) => (console.error(`market view could not start: ${e.message}`), process.exit(1)));
marketServer.listen(MARKET_PORT, '127.0.0.1', () => console.log(`read-only market analyzer: http://localhost:${MARKET_PORT}`));

// The trading bot's full dashboard, with every control. The bot itself stays local-only (it refuses any Host but
// localhost); this passes requests on as if they came from its own page on this PC, after checking that:
//  - through Tailscale, the person is the owner of this PC's Tailscale account (or in VIEWER_ALLOW), not just any
//    device or user the PC might be shared with;
//  - changes come from this page itself (same Origin), so another website can't drive it from your browser.
const FULL_PORT = Number(process.env.VIEWER_FULL_PORT) || 8792;
const FULL_TS_PORT = Number(process.env.VIEWER_FULL_TS_PORT) || 8444;
const FULL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const FULL_STRIP = `<style>#ro-strip { background: #3a1716; color: #ff8a84; font: 600 12px system-ui, sans-serif; text-align: center; padding: 4px 8px; }
#ro-strip a { color: inherit; }</style>`;

let owners = ALLOW;
if (!owners.length) {
  const exe = process.env.TAILSCALE_EXE || (process.platform === 'win32' ? 'C:/Program Files/Tailscale/tailscale.exe' : 'tailscale');
  execFile(exe, ['status', '--json'], { timeout: 10_000 }, (err, out) => {
    try {
      if (err) throw err;
      const j = JSON.parse(out);
      const login = j.User?.[j.Self?.UserID]?.LoginName;
      if (!login) throw new Error('no login in tailscale status');
      owners = [login.toLowerCase()];
      console.log(`full bot dashboard: only ${login} can use it through Tailscale`);
    } catch (e) {
      console.log(`full bot dashboard: could not tell who owns this PC's Tailscale (${e.message}); remote use is off until VIEWER_ALLOW is set`);
    }
  });
}

const fullServer = http.createServer((req, res) => {
  const fail = (code, error) => {
    res.writeHead(code, { 'content-type': 'application/json', ...SECURITY });
    res.end(JSON.stringify({ error }));
  };
  const host = (req.headers.host ?? '').toLowerCase();
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  if (!local && !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(:\d+)?$/.test(host)) return fail(403, 'forbidden host');
  if (!local && !owners.includes(String(req.headers['tailscale-user-login'] ?? '').toLowerCase())) return fail(403, 'not allowed');
  const changing = req.method !== 'GET' && req.method !== 'HEAD';
  if (changing && req.headers.origin !== `${local ? 'http' : 'https'}://${host}`) return fail(403, 'forbidden origin');

  const bot = new URL(BOT);
  const headers = { host: bot.host, accept: req.headers.accept ?? '*/*' };
  for (const h of ['content-type', 'content-length', 'x-bot-ui']) if (req.headers[h]) headers[h] = req.headers[h];
  if (changing) headers.origin = bot.origin;
  const up = http.request({ hostname: bot.hostname, port: bot.port, path: req.url, method: req.method, headers, timeout: 60_000 }, (r) => {
    const type = r.headers['content-type'] ?? 'application/octet-stream';
    if (!type.startsWith('text/html')) {
      res.writeHead(r.statusCode, { 'content-type': type, ...SECURITY });
      return r.pipe(res);
    }
    let html = '';
    r.setEncoding('utf8');
    r.on('data', (c) => (html += c));
    r.on('end', () => {
      const back = local ? `http://localhost:${PORT}/` : `https://${host.split(':')[0]}/`;
      html = html.replace('</head>', FULL_STRIP + '</head>')
        .replace(/<body([^>]*)>/, `<body$1><div id="ro-strip">Remote, full control: changes here are live · <a href="${back}">back to status</a></div>`);
      res.writeHead(r.statusCode, { 'content-type': type, ...SECURITY, 'content-security-policy': FULL_CSP });
      res.end(html);
    });
  });
  up.on('timeout', () => up.destroy(new Error('the bot did not answer')));
  up.on('error', (e) => (res.headersSent ? res.destroy() : fail(502, e.code === 'ECONNREFUSED' ? 'The bot is not running on the PC.' : e.message)));
  if (changing) console.log(`${new Date().toISOString()} full dashboard: ${req.method} ${req.url.split('?')[0]} from ${who(req)}`);
  req.pipe(up);
});
fullServer.on('error', (e) => (console.error(`full bot dashboard could not start: ${e.message}`), process.exit(1)));
fullServer.listen(FULL_PORT, '127.0.0.1', () => console.log(`full bot dashboard: http://localhost:${FULL_PORT}`));

// Dedicated money bot dashboard. The same owner/origin checks protect its controls on a phone.
const MONEY_PORT = Number(process.env.VIEWER_MONEY_PORT) || 8793;
const MONEY_TS_PORT = Number(process.env.VIEWER_MONEY_TS_PORT) || 8445;
const MONEY_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MONEY_WRITES = new Set(['/api/cookie', '/api/run', '/api/pause', '/api/resume', '/api/packs/retry',
  '/api/premium/settings', '/api/premium/cookie', '/api/premium/run', '/api/premium/packs/retry',
  '/api/premium/pause', '/api/premium/resume']);
const MONEY_READS = new Set(['/', '/index.html', '/history', '/api/state', '/api/examples', '/api/auctions', '/api/history',
  '/premium', '/premium/overview', '/premium/deals', '/premium/history', '/premium/settings',
  '/api/premium/state', '/api/premium/deals', '/api/premium/settings', '/api/premium/history',
  '/api/premium/snipe-history',
  '/api/premium/examples', '/api/premium/auctions']);
const moneyServer = http.createServer((req, res) => {
  const fail = (code, error) => {
    res.writeHead(code, { 'content-type': 'application/json', ...SECURITY });
    res.end(JSON.stringify({ error }));
  };
  const host = String(req.headers.host ?? '').toLowerCase();
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  if (!local && !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(:\d+)?$/.test(host)) return fail(403, 'forbidden host');
  if (!local && !owners.includes(String(req.headers['tailscale-user-login'] ?? '').toLowerCase())) return fail(403, 'not allowed');
  const path = new URL(req.url, 'http://x').pathname;
  const changing = req.method === 'POST';
  if (changing && !MONEY_WRITES.has(path) && !/^\/api\/(?:premium\/)?listings\/[a-zA-Z0-9-]+\/remove$/.test(path)) return fail(405, 'read only');
  if (!changing && (req.method !== 'GET' && req.method !== 'HEAD' || !MONEY_READS.has(path)
      && !/^\/api\/(?:premium\/)?listings\/[a-zA-Z0-9-]+\/details$/.test(path)
      && !/^\/api\/premium\/deals\/[a-zA-Z0-9-]+\/details$/.test(path))) return fail(404, 'not found');
  if (changing && req.headers.origin !== `${local ? 'http' : 'https'}://${host}`) return fail(403, 'forbidden origin');
  if (changing && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return fail(415, 'send JSON');
  const upUrl = new URL(MONEY);
  const headers = { host: upUrl.host, accept: req.headers.accept ?? '*/*' };
  for (const h of ['content-type', 'content-length']) if (req.headers[h]) headers[h] = req.headers[h];
  if (changing) headers.origin = upUrl.origin;
  const up = http.request({ hostname: upUrl.hostname, port: upUrl.port, path: req.url, method: req.method, headers, timeout: 60_000 }, (r) => {
    const type = r.headers['content-type'] ?? 'application/octet-stream';
    if (!type.startsWith('text/html')) {
      res.writeHead(r.statusCode, { 'content-type': type, ...SECURITY });
      return r.pipe(res);
    }
    let html = '';
    r.setEncoding('utf8');
    r.on('data', (chunk) => (html += chunk));
    r.on('end', () => {
      const back = local ? `http://localhost:${PORT}/` : `https://${host.split(':')[0]}/`;
      html = html.replace('</head>', `<style>#remote-strip{padding:5px 10px;background:#493321;color:#ffe0a2;font:12px system-ui}#remote-strip a{color:inherit}</style></head>`)
        .replace(/<body([^>]*)>/, `<body$1><div id="remote-strip">Remote money dashboard · changes here are live when enabled · <a href="${back}">back to status</a></div>`);
      res.writeHead(r.statusCode, { 'content-type': type, ...SECURITY, 'content-security-policy': MONEY_CSP });
      res.end(html);
    });
  });
  up.on('timeout', () => up.destroy(new Error('the money bot did not answer')));
  up.on('error', (e) => (res.headersSent ? res.destroy() : fail(502, e.code === 'ECONNREFUSED' ? 'The money bot is not running on the PC.' : e.message)));
  if (changing) console.log(`${new Date().toISOString()} money dashboard: ${req.method} ${path} from ${who(req)}`);
  req.pipe(up);
});
moneyServer.on('error', (e) => (console.error(`money dashboard proxy could not start: ${e.message}`), process.exit(1)));
moneyServer.listen(MONEY_PORT, '127.0.0.1', () => console.log(`money dashboard proxy: http://localhost:${MONEY_PORT}`));
