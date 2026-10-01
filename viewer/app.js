// Read-only: polls /api/summary and draws it. Nothing on this page can send anything back to the bots.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
const signed = (n) => (n == null ? '—' : `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${num(n)}</span>`);
const dur = (sec) => {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${String(Math.floor(sec / 60) % 60).padStart(2, '0')}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor(sec / 3600) % 24}h`;
};
const bytes = (b) => (b == null ? '—' : b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);
const pill = (text, kind = '') => `<span class="pill ${kind}">${esc(text)}</span>`;
const stat = (k, v, s = '') => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
const rar = (r) => (r ? `<span class="rar">${esc(r)}</span>` : '');
const list = (items, row, empty) => (items?.length ? `<ul class="rows">${items.map(row).join('')}</ul>` : `<div class="empty">${esc(empty)}</div>`);

// Times shown as "in 3m" / "4m ago" are kept live by tick() between refreshes. `skew` turns the PC's clock into ours.
let skew = 0;
const until = (ms) => `<span data-until="${ms}">${dur((ms - Date.now()) / 1000)}</span>`;
const ago = (ms) => (ms ? `<span data-ago="${ms}">${dur((Date.now() - ms) / 1000)}</span> ago` : 'never');
const pcTime = (t) => (t == null ? null : (typeof t === 'number' ? t : Date.parse(t)) - skew);
function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('[data-until]')) el.textContent = dur((+el.dataset.until - now) / 1000);
  for (const el of document.querySelectorAll('[data-ago]')) el.textContent = dur((now - +el.dataset.ago) / 1000);
  if (lastOk) {
    const age = (now - lastOk) / 1000;
    $('updated').textContent = age < 2 ? 'live' : `updated ${dur(age)} ago`;
    $('dot').classList.toggle('stale', age > 20);
  }
}

function spark(points, key) {
  const vals = points.map((p) => p[key] ?? 0);
  const max = Math.max(1, ...vals);
  const w = 300, h = 56, step = w / Math.max(1, vals.length - 1);
  const xy = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(key)} per minute, last hour, peak ${max}">
    <polygon points="0,${h} ${xy.join(' ')} ${w},${h}" fill="var(--spark)" opacity=".15"/>
    <polyline points="${xy.join(' ')}" fill="none" stroke="var(--spark)" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderBot(b) {
  if (!b.online) {
    return `<div class="card-head"><h2>Trading bot</h2>${pill('OFFLINE', 'bad')}</div>
      <div class="alert">The bot is ${esc(b.error)}. If it was started with start-bot.bat it restarts itself within ~10s; otherwise someone has to start it on the PC.</div>`;
  }
  const r = b.report ?? {};
  const m = b.money ?? {};
  const pills = [
    pill(b.mode === 'live' ? 'LIVE' : 'DRY RUN', b.mode === 'live' ? 'good' : 'warn'),
    b.paused ? pill('PAUSED', 'warn') : '',
    b.connected ? pill('logged in', 'good') : pill('not logged in', 'bad'),
  ].join('');
  const alerts = [
    b.sessionProblem ? `<div class="alert">${esc(b.sessionProblem)}</div>` : '',
    b.paused ? `<div class="alert warn">Paused from the dashboard: no bids, packs or recycling until resumed on the PC.</div>` : '',
  ].join('');
  const spentPct = b.dailySpendCap ? Math.round((b.spentToday / b.dailySpendCap) * 100) : null;
  const stats = [
    stat('Balance', num(b.balance), `net this run ${signed(m.net)}`),
    stat('Spent today', num(b.spentToday), `cap ${num(b.dailySpendCap)}${spentPct != null ? ` · ${spentPct}%` : ''}`),
    stat('Held in bids', num(m.heldInBids), `${num(m.pending)} pending`),
    stat('Won / outbid', `${num(m.won)} / ${num(m.outbid)}`, `7 days: ${num(r.won7d)} / ${num(r.lost7d)}`),
    stat('Collection', num(r.collection?.cards), `worth ~${num(r.collection?.totalValue)}`),
    stat('Recycled', num(m.recycledCount), `+${num(m.earnedRecycling)} · ${num(b.stats?.packs)} packs`),
    stat('Last scan', b.scan ? (b.scan.lastAt ? ago(pcTime(b.scan.lastAt)) : 'not yet') : '—', esc(b.scan?.summary || '')),
    stat('Uptime', dur(b.uptimeSec), `login ${b.sessionMinLeft > 0 ? `refreshes in ${b.sessionMinLeft}m` : 'refreshing'}`),
  ].join('');

  const now = Date.now();
  const plans = list(b.plans, (p) => `<li><span class="l">${rar(p.rarity)}${esc(p.title)}</span><span class="r"><b>${num(p.amount)}</b> · ${until(now + p.fireInSec * 1000)}</span></li>`, 'No snipes planned right now.');
  const watching = list(r.watching, (t) => `<li><span class="l">${rar(t.rarity)}${esc(t.title)}</span><span class="r">${t.leading ? pill('leading', 'good') + ' ' : ''}<b>${num(t.price)}</b>/${num(t.maxBid)} · ${until(pcTime(t.endsAt))}</span></li>`, 'No target is up for auction.');
  const results = list(r.results, (e) => `<li><span class="l">${rar(e.rarity)}${esc(e.title)}</span><span class="r">${e.type === 'won' ? pill('won', 'good') : pill('lost', 'bad')} <b>${num(e.price)}</b> · ${ago(pcTime(e.at))}</span></li>`, 'Nothing won or lost in the last 7 days.');
  const themes = list(r.themes, (t) => `<li><span class="l">${esc(t.name)}${t.enabled === false ? ' <span class="muted">(off)</span>' : ''}</span><span class="r">${num(t.owned)}/${num(t.targets)} owned · spent <b>${num(t.spent7d)}</b>${t.weeklyBudget != null ? ` of ${num(t.weeklyBudget)}` : ''}</span></li>`, 'No themes.');

  return `<div class="card-head"><h2>Trading bot</h2><div class="pills">${pills}</div></div>${alerts}
    <div class="stats">${stats}</div>
    <h3>Next snipes</h3>${plans}
    <h3>Targets in auction</h3>${watching}
    <h3>Recent results</h3>${results}
    <h3>Themes (7 days)</h3>${themes}
    <details${openLog ? ' open' : ''} id="logbox"><summary>Recent log (${b.log?.length ?? 0} lines)</summary><pre>${esc((b.log ?? []).slice().reverse().join('\n'))}</pre></details>`;
}

function renderMarket(mk) {
  if (!mk.online) {
    return `<div class="card-head"><h2>Market analyzer</h2>${pill('OFFLINE', 'bad')}</div>
      <div class="alert">The market analyzer is ${esc(mk.error)}. Start it on the PC with market-analyzer/start-market.bat.</div>`;
  }
  const c = mk.collector ?? {};
  const loggedOut = (mk.accounts ?? []).filter((a) => !a.hasCookie || a.needsLogin);
  const healthy = !c.needsLogin && !c.lastError && c.recentLagSec < 60;
  const pills = [
    c.needsLogin ? pill('needs login', 'bad') : healthy ? pill('collecting', 'good') : pill('behind', 'warn'),
    c.slowedDown ? pill('slowed down', 'warn') : '',
  ].join('');
  const alerts = [
    loggedOut.length ? `<div class="alert">${loggedOut.map((a) => esc(a.slot)).join(' and ')} account needs a fresh cookie (paste it on the PC dashboard).</div>` : '',
    c.lastError ? `<div class="alert warn">Last error: ${esc(c.lastError)}</div>` : '',
  ].join('');
  const stats = [
    stat('Settled, 5 min', num(c.last5min?.settled), `${num(c.last5min?.sold)} sold`),
    stat('Settled, 1 hour', num(c.lastHour?.settled), `${num(c.lastHour?.sold)} sold`),
    stat('New listings lag', dur(c.recentLagSec), `last sweep ${ago(pcTime(c.lastSweepAt))}`),
    stat('Watching', num(c.pending), `${num(c.overdue)} overdue`),
    stat('Requests, 5 min', num(c.last5min?.requests), `${num(c.lastHour?.requests)} / hour`),
    stat('Database', bytes(mk.db?.bytes), `${num(mk.db?.auctions)} auctions`),
    stat('24h volume', num(mk.day?.volume), `${num(mk.day?.sold)} of ${num(mk.day?.n)} sold`),
    stat('Running for', c.startedAt ? dur((Date.now() - pcTime(c.startedAt)) / 1000) : '—', mk.db?.oldest ? `data since ${new Date(pcTime(mk.db.oldest)).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : ''),
  ].join('');
  const accounts = list(mk.accounts, (a) => `<li><span class="l">${esc(a.slot)} · ${esc(a.username ?? 'no login')}</span><span class="r">${!a.hasCookie || a.needsLogin ? pill('needs login', 'bad') : a.blockedReason ? pill('blocked', 'bad') : a.slowedDown ? pill('slowed', 'warn') : pill('ok', 'good')}</span></li>`, 'No accounts.');
  return `<div class="card-head"><h2>Market analyzer</h2><div class="pills">${pills}</div></div>${alerts}
    <div class="stats">${stats}</div>
    <h3>Auctions settled per minute, last hour</h3>${spark(c.perMinute ?? [], 'settled')}
    <h3>Accounts</h3>${accounts}`;
}

let lastOk = 0;
let openLog = false;
async function refresh() {
  try {
    const sent = Date.now();
    const r = await fetch('/api/summary', { cache: 'no-store' });
    if (!r.ok) throw new Error(`the viewer answered HTTP ${r.status}`);
    const d = await r.json();
    skew = Date.parse(d.at) - (sent + Date.now()) / 2;
    openLog = $('logbox')?.open ?? openLog;
    $('bot').innerHTML = renderBot(d.bot);
    $('market').innerHTML = renderMarket(d.market);
    $('error').hidden = true;
    lastOk = Date.now();
  } catch (e) {
    $('error').textContent = `Can't reach the PC (${e.message}). It may be asleep, offline, or the viewer isn't running.`;
    $('error').hidden = false;
  }
  tick();
}

let timer;
function schedule() {
  clearInterval(timer);
  if (document.hidden) return;
  refresh();
  timer = setInterval(refresh, 5000);
}
document.addEventListener('visibilitychange', schedule);
setInterval(tick, 1000);
schedule();
