import fs from 'node:fs';
import { Session } from './http.js';
import { calibrate } from './clock.js';
import { decide, describe, plain } from './rules.js';
import { startPacks } from './packs.js';
import { startSelling } from './sell.js';
import { loadConfig, watchConfig } from './config.js';
import { startUI } from './ui.js';

const cfg = loadConfig();
const LIVE = process.argv.includes('--live');
const ONCE = process.argv.includes('--once');
const DRY = !LIVE || cfg.dryRun === true; // live needs BOTH --live and dryRun:false
const T = cfg.timing;
const LOG = new URL('../bids.jsonl', import.meta.url);

const session = new Session();
session.onLog = (m) => log(m);
if (!cfg.myUserId) cfg.myUserId = session.readAuth()?.user?.id ?? '';
const plans = new Map(); // auctionId -> { endAt, timer, rule, amount }
const recentBids = []; // local timestamps of sent bids
let clock = { offsetMs: 0, rttMs: 300, uncertaintyMs: 1000 };
let balance = null;
let sessionProblem = null;
let wishlist = new Set();
let wishlistTitles = [];
let spentToday = { day: '', won: 0 }; // won = price of auctions won today; refunded bids never count
let lastBidAt = 0;

const ts = () => new Date().toISOString().slice(11, 23);
const logRing = [];
const log = (...a) => {
  const line = `${ts()} ${a.join(' ')}`;
  console.log(line);
  logRing.push(line);
  if (logRing.length > 400) logRing.shift();
};
const control = { paused: false };

/** Newest-first records from bids.jsonl (bids and auction end-time events share the file). */
function recentRecords() {
  try {
    return fs.readFileSync(LOG, 'utf8').trim().split(String.fromCharCode(10)).slice(-80).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}
const stats = { bidsOk: 0, bidsFailed: 0, packs: 0, recycled: 0, earned: 0, won: 0, lost: 0, wonSpent: 0, listed: 0, soldCount: 0, soldRevenue: 0 };
const sellInfo = { active: 0, max: 5, preview: [], lastRunAt: null };
const pendingBids = new Map(); // auction id -> { title, amount } for bids whose auction has not finished
let startBalance = null;
const startedAt = Date.now();
const record = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverNow = () => Date.now() + clock.offsetMs;
const jitter = () => (Math.random() * 2 - 1) * T.jitterMs;

async function fetchPage(page) {
  const r = await session.request('GET', `/api/marketplace?page=${page}&limit=50&sort=ending_soon`);
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) {
    sessionProblem = 'The site rejected your login. Paste a fresh cookie on the Connect tab.';
    throw new Error(`Session rejected (HTTP ${r.status}${r.location ? ' -> ' + r.location : ''}). Paste a fresh cookie on the dashboard Connect tab.`);
  }
  if (r.status !== 200 || !r.json?.auctions) throw new Error(`List failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  sessionProblem = null;
  return r.json;
}

async function listAuctions(maxPages = T.maxPages) {
  const out = [];
  const horizon = Date.now() + clock.offsetMs + T.horizonMinutes * 60_000;
  for (let p = 1; p <= maxPages; p++) {
    const j = await fetchPage(p);
    out.push(...j.auctions);
    if (!j.hasMore || !j.auctions.length || Date.parse(j.auctions.at(-1).end_at) > horizon) break;
  }
  return out;
}

async function refreshWishlist() {
  const ids = new Set();
  const titles = new Set();
  for (let p = 0; p < 20; p++) {
    const r = await session.request('GET', `/api/cards?page=${p}&sort=rarity&wishlist=1`);
    if (r.status !== 200 || !Array.isArray(r.json?.cards)) throw new Error(`wishlist fetch failed: HTTP ${r.status}`);
    (r.json.wishlistCardIds ?? []).forEach((i) => ids.add(i));
    r.json.cards.forEach((c) => (ids.add(c.id), titles.add(c.wikipedia_title)));
    if (!r.json.cards.length || titles.size >= (r.json.total ?? 0)) break;
  }
  wishlist = ids;
  wishlistTitles = [...titles];
  log(`wishlist: ${wishlist.size} cards`);
}

/** The marketplace is huge, so find wishlist auctions by title search and match on card id. */
async function wishlistAuctions() {
  const out = new Map();
  // The site's search does not match the "(qualifier)" part of a title, so search on the text before it.
  // query text -> which results to keep. Wishlist titles keep wishlist cards; a rule's "titleContains" keeps titles containing it.
  const searches = new Map();
  for (const t of wishlistTitles) searches.set(t.split('(')[0].trim() || t, (a) => wishlist.has(a.card_id));
  for (const rule of cfg.rules) {
    const kw = rule.enabled !== false && rule.when?.titleContains;
    if (kw && !searches.has(kw)) searches.set(kw, (a) => plain(a.card?.wikipedia_title).includes(plain(kw)));
  }
  for (const [q, keep] of searches) {
    const maxPages = q.length < 4 ? 20 : 8; // very short queries match a lot of auctions
    for (let p = 1; p <= maxPages; p++) {
      const r = await session.request('GET', `/api/marketplace?page=${p}&limit=50&sort=ending_soon&q=${encodeURIComponent(q)}`);
      if (r.status !== 200 || !r.json?.auctions) break;
      for (const a of r.json.auctions) if (keep(a)) out.set(a.id, a);
      if (!r.json.hasMore) break;
    }
  }
  return [...out.values()];
}

async function refreshBalance() {
  const r = await session.request('GET', '/api/wikibidous');
  if (r.status === 200 && typeof r.json?.balance === 'number') {
    balance = r.json.balance;
    if (startBalance === null) startBalance = balance;
    log(`balance: ${balance}`);
  }
}

async function getAuction(id) {
  const r = await session.request('GET', `/api/marketplace/${id}`);
  if (r.status === 200 && r.json?.auction) return r.json.auction;
  throw new Error(`getAuction HTTP ${r.status} ${r.text.slice(0, 120)}`);
}

function heldInBids(exceptAuctionId) {
  let sum = 0;
  for (const [id, p] of pendingBids) if (id !== exceptAuctionId) sum += p.amount;
  return sum;
}

function committedToday(exceptAuctionId) {
  const day = new Date().toISOString().slice(0, 10);
  if (spentToday.day !== day) spentToday = { day, won: 0 };
  return spentToday.won + heldInBids(exceptAuctionId);
}

function budgetOk(amount, { skipGap = false, auctionId } = {}) {
  const now = Date.now();
  while (recentBids.length && now - recentBids[0] > 3600_000) recentBids.shift();
  if (recentBids.length >= cfg.global.maxSnipesPerHour) return 'hourly snipe cap';
  if (!skipGap && now - lastBidAt < cfg.global.minGapBetweenBidsMs) return 'min gap between bids';
  const committed = committedToday(auctionId);
  if (committed + amount > cfg.global.dailySpendCap) return `daily spend cap (${committed} already won or held + ${amount} > ${cfg.global.dailySpendCap})`;
  if (balance !== null && amount > balance - cfg.global.reserveBalance) return `balance ${balance} (reserve ${cfg.global.reserveBalance})`;
  return null;
}

function schedule(a, decision) {
  const endMs = Date.parse(a.end_at);
  const oneWay = clock.rttMs / 2 + T.extraBidLatencyMs;
  // Local time at which to send so the server receives the bid ~targetRemainingMs before end.
  const fireAt = endMs - T.targetRemainingMs - oneWay - clock.offsetMs + jitter();
  const prev = plans.get(a.id);
  if (prev) clearTimeout(prev.timer);
  const wait = fireAt - Date.now();
  if (wait < -1000) return void log(`skip (too late by ${(-wait / 1000).toFixed(1)}s): ${describe(a)}`);

  const preAt = Math.max(0, wait - Math.max(T.preCheckLeadMs, clock.rttMs * 2 + 1500));
  const plan = { endAt: a.end_at, rule: decision.rule, amount: decision.amount, auction: a, fireAt };
  plan.timer = setTimeout(() => preCheck(a.id), preAt);
  plans.set(a.id, plan);
  log(`PLAN ${describe(a)} rule=${decision.rule} bid=${decision.amount} fire in ${(wait / 1000).toFixed(1)}s (end ${a.end_at})`);
}

/** Re-read the auction shortly before firing: end time may have been extended, or the price may have moved. */
async function preCheck(id) {
  const plan = plans.get(id);
  if (!plan) return;
  let a = plan.auction;
  try {
    [a] = await Promise.all([getAuction(id), refreshBalance().catch(() => {})]);
  } catch (e) {
    log(`preCheck lookup failed (${e.message}); firing on the original plan`);
  }
  if (a.status !== 'active') return void (plans.delete(id), log(`auction ${id} not active (${a.status})`));
  const d = decide(cfg, a, cfg.myUserId, wishlist);
  if (d.action !== 'bid') return void (plans.delete(id), log(`drop ${describe(a)}: ${d.reason}`));
  if (a.end_at !== plan.endAt) log(`end time moved ${plan.endAt} -> ${a.end_at}`);
  fireWhenReady(a, d);
}

async function fireWhenReady(a, decision) {
  const endMs = Date.parse(a.end_at);
  const oneWay = clock.rttMs / 2 + T.extraBidLatencyMs;
  const fireAt = endMs - T.targetRemainingMs - oneWay - clock.offsetMs + jitter();
  let wait = fireAt - Date.now();
  if (wait < -500) return void (plans.delete(a.id), log(`missed window by ${(-wait / 1000).toFixed(1)}s: ${describe(a)}`));
  if (wait > 30) await sleep(wait - 25);
  while (Date.now() < fireAt) {} // spin for the last few ms
  await placeBid(a, decision, fireAt);
}

const watching = new Set(); // auctions we have bid on and are still following

/** Counter-bids allowed on an auction we already bid on: rule setting, else the global default. */
const countersFor = (ruleName) => cfg.rules.find((r) => r.name === ruleName)?.bid?.counters ?? cfg.global.counters ?? 2;

/**
 * Follow an auction after our bid. If someone outbids us, queue a new snipe (as long as the rules still
 * allow the new price); when the auction has ended, record whether we won or were outbid.
 */
async function watchAuction(a, amount, ruleName) {
  if (watching.has(a.id)) return;
  watching.add(a.id);
  const title = a.card?.wikipedia_title;
  let counters = 0;
  let lastEnd = a.end_at;
  let lastRival = null;
  const started = Date.now();
  try {
    while (Date.now() - started < 3 * 3600_000) {
      await sleep(800 + Math.random() * 500); // only watches for the ~15-30 s around the end
      let cur;
      try {
        cur = await getAuction(a.id);
      } catch {
        continue;
      }
      if (cur.end_at !== lastEnd) {
        const by = Date.parse(cur.end_at) - Date.parse(lastEnd);
        log(`end time moved +${by / 1000}s on ${title}`);
        record({ event: 'extended', id: a.id, title, movedMs: by, msLeftWhenSeen: Date.parse(lastEnd) - serverNow() });
        lastEnd = cur.end_at;
      }
      if (cur.status !== 'active') {
        pendingBids.delete(a.id);
        if (cur.winner_id && cur.winner_id === cfg.myUserId) {
          stats.won++;
          stats.wonSpent += cur.final_price ?? amount;
          committedToday(); // rolls the day over if needed
          spentToday.won += cur.final_price ?? amount;
          log(`WON ${title} for ${cur.final_price ?? amount}`);
        } else {
          stats.lost++;
          log(`OUTBID on ${title}: lost at ${cur.final_price ?? cur.current_bid} (my bid refunded)`);
        }
        refreshBalance().catch(() => {});
        return;
      }
      if (cur.current_bidder_id && cur.current_bidder_id !== cfg.myUserId && cur.current_bid !== lastRival) {
        lastRival = cur.current_bid;
        log(`someone bid ${cur.current_bid} on ${title} after us`);
        if (counters >= countersFor(ruleName)) {
          log(`no more counters for ${title} (limit ${countersFor(ruleName)})`);
          continue;
        }
        const d = decide(cfg, cur, cfg.myUserId, wishlist);
        if (d.action !== 'bid') {
          log(`not countering ${title}: ${d.reason}`);
          continue;
        }
        counters++;
        queueCounter(cur, d);
      }
    }
  } finally {
    watching.delete(a.id);
    pendingBids.delete(a.id);
  }
}

/** Schedule a new snipe after being outbid: normal lead time if it is still reachable, else a shorter one. */
function queueCounter(cur, decision) {
  const oneWay = clock.rttMs / 2 + T.extraBidLatencyMs;
  const msLeft = Date.parse(cur.end_at) - serverNow();
  let lead = T.targetRemainingMs;
  let wait = msLeft - lead - oneWay;
  if (wait < 300) {
    lead = T.counterRemainingMs ?? 3500; // the normal window has passed; this bid will extend the auction again
    wait = msLeft - lead - oneWay;
  }
  if (msLeft < 1500) return void log(`too late to counter on ${cur.card?.wikipedia_title} (${msLeft}ms left)`);
  wait = Math.max(0, wait) + jitter();
  log(`COUNTER queued: ${describe(cur)} bid=${decision.amount} in ${(Math.max(0, wait) / 1000).toFixed(1)}s (${(lead / 1000).toFixed(1)}s before the end)`);
  setTimeout(async () => {
    try {
      const fresh = await getAuction(cur.id);
      if (fresh.status !== 'active' || fresh.current_bidder_id === cfg.myUserId) return; // ended, or already ours
      const d = decide(cfg, fresh, cfg.myUserId, wishlist);
      if (d.action !== 'bid') return void log(`counter dropped for ${fresh.card?.wikipedia_title}: ${d.reason}`);
      await placeBid(fresh, d, Date.now(), { counter: true });
    } catch (e) {
      log('counter error:', e.message);
    }
  }, wait);
}

async function placeBid(a, decision, fireAt, { counter = false } = {}) {
  if (control.paused) {
    plans.delete(a.id);
    return void log(`PAUSED: skipped bid ${decision.amount} on ${describe(a)}`);
  }
  const why = budgetOk(decision.amount, { auctionId: a.id });
  if (why) {
    plans.delete(a.id);
    return void log(`BLOCKED (${why}): ${describe(a)}`);
  }
  const sentLocal = Date.now();
  const predictedRemainingMs = Date.parse(a.end_at) - (sentLocal + clock.offsetMs + clock.rttMs / 2 + T.extraBidLatencyMs);
  if (DRY) {
    log(`DRY-RUN would bid ${decision.amount} on ${describe(a)} (${(predictedRemainingMs / 1000).toFixed(2)}s before end at arrival, ${sentLocal - fireAt}ms late)`);
    record({ dry: true, id: a.id, amount: decision.amount, predictedRemainingMs });
    return void plans.delete(a.id);
  }
  lastBidAt = sentLocal;
  recentBids.push(sentLocal);
  let r = await session.request('POST', `/api/marketplace/${a.id}/bid`, { json: { amount: decision.amount } });
  // "bid too low": the server says the minimum. Retry at once (still well before the last 10 s) if the rule's max allows it.
  if (r.status === 409 && r.json?.code === 'bid_too_low' && Number.isFinite(r.json.min)) {
    const max = cfg.rules.find((x) => x.name === decision.rule)?.bid?.max ?? 0;
    const why2 = r.json.min > max ? `minimum ${r.json.min} is above this rule's max ${max}` : budgetOk(r.json.min, { skipGap: true, auctionId: a.id });
    if (!why2) {
      log(`bid ${decision.amount} was too low (minimum ${r.json.min}); retrying at ${r.json.min}`);
      decision = { ...decision, amount: r.json.min };
      r = await session.request('POST', `/api/marketplace/${a.id}/bid`, { json: { amount: decision.amount } });
    } else log(`bid too low and not retried: ${why2}`);
  }
  const ok = r.status === 200 && r.json?.current_bid !== undefined;
  if (ok) {
    balance = r.json.bidder_balance ?? balance;
  }
  ok ? stats.bidsOk++ : stats.bidsFailed++;
  if (ok) {
    pendingBids.set(a.id, { title: a.card?.wikipedia_title, amount: decision.amount });
    watchAuction(a, decision.amount, decision.rule).catch(() => pendingBids.delete(a.id));
  }
  log(`${ok ? 'BID OK' : 'BID FAILED'} ${decision.amount} on ${describe(a)} http=${r.status} rtt=${r.t1 - r.t0}ms balance=${balance} ${ok ? '' : r.text.slice(0, 200)}`);
  plans.delete(a.id);

  // Did our bid extend the auction? If so we were inside the last 10 s and need a larger margin.
  await sleep(1500);
  let extended = null;
  try {
    const after = await getAuction(a.id);
    extended = after ? Date.parse(after.end_at) - Date.parse(a.end_at) : null;
  } catch {}
  if (extended > 0 && counter) log(`counter-bid extended the auction by ${extended / 1000}s (expected for a counter)`);
  else if (extended > 0) log(`!! auction was EXTENDED by ${extended / 1000}s -> we landed too late. Increase timing.extraBidLatencyMs (try +${Math.min(1500, Math.round((r.t1 - r.t0) / 2))}).`);
  else if (ok) log('auction end unchanged -> bid landed before the extension window.');
  record({ counter, id: a.id, title: a.card?.wikipedia_title, rarity: a.snapshot_rarity, amount: decision.amount, status: r.status, body: r.json ?? r.text.slice(0, 300), predictedRemainingMs, rttMs: r.t1 - r.t0, extendedMs: extended, sentLocal, serverDate: r.date });
}

async function poll(withWishlist = true) {
  const near = await listAuctions();
  const wl = withWishlist ? await wishlistAuctions() : [];
  const wlIds = new Set(wl.map((a) => a.id));
  const list = [...new Map([...near, ...wl].map((a) => [a.id, a])).values()];
  const horizon = serverNow() + T.horizonMinutes * 60_000;
  let planned = 0;
  const seen = {};
  for (const a of list) {
    seen[a.snapshot_rarity] = (seen[a.snapshot_rarity] ?? 0) + 1;
    const endMs = Date.parse(a.end_at);
    if ((endMs > horizon && !wlIds.has(a.id)) || endMs < serverNow()) continue;
    const d = decide(cfg, a, cfg.myUserId, wishlist);
    if (d.action !== 'bid') continue;
    if (watching.has(a.id)) continue;
    const prev = plans.get(a.id);
    if (prev && prev.endAt === a.end_at) continue;
    schedule(a, d);
    planned++;
  }
  log(`poll: ${list.length} auctions (${wl.length} from searches), ${planned} newly planned, ${plans.size} active plans`);
}

async function main() {
  log(`mode: ${DRY ? 'DRY-RUN (pass --live to place real bids)' : 'LIVE'}`);
  if (!ONCE && cfg.ui?.enabled !== false) {
    startUI({
      port: cfg.ui?.port ?? 8787,
      control,
      log,
      session,
      onConnected: () => {
        sessionProblem = null;
        if (!cfg.myUserId) cfg.myUserId = session.readAuth()?.user?.id ?? '';
      },
      getState: () => ({
        mode: DRY ? 'dry-run' : 'live',
        connected: session.hasCookie() && !sessionProblem,
        sessionProblem: session.hasCookie() ? sessionProblem : 'No login yet. Use the Connect tab.',
        paused: control.paused,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        balance,
        wishlistSize: wishlist.size,
        clock: { offsetMs: Math.round(clock.offsetMs), rttMs: clock.rttMs },
        sessionMinLeft: Math.round(((session.readAuth()?.expires_at ?? 0) - Date.now() / 1000) / 60),
        money: {
          startBalance,
          balance,
          net: startBalance === null || balance === null ? null : balance - startBalance,
          earnedRecycling: stats.earned,
          recycledCount: stats.recycled,
          spentOnWon: stats.wonSpent,
          earnedSales: stats.soldRevenue,
          soldCount: stats.soldCount,
          won: stats.won,
          outbid: stats.lost,
          pending: pendingBids.size,
          heldInBids: [...pendingBids.values()].reduce((s, p) => s + p.amount, 0),
        },
        sell: { enabled: cfg.sell.enabled, active: sellInfo.active, max: sellInfo.max, listed: stats.listed, soldCount: stats.soldCount, soldRevenue: stats.soldRevenue, factor: cfg.sell.priceFactor, preview: sellInfo.preview, lastRunAt: sellInfo.lastRunAt },
        spentToday: committedToday(),
        dailySpendCap: cfg.global.dailySpendCap,
        stats,
        plans: [...plans.entries()]
          .map(([id, p]) => ({ id, title: p.auction?.card?.wikipedia_title, rarity: p.auction?.snapshot_rarity, amount: p.amount, rule: p.rule, endAt: p.endAt, fireInSec: Math.round((p.fireAt - Date.now()) / 1000) }))
          .sort((x, y) => x.fireInSec - y.fireInSec),
        recentBids: recentRecords().filter((r) => r.event === undefined).slice(0, 15),
        extensions: recentRecords().filter((r) => r.event === 'extended').slice(0, 8),
        log: logRing.slice(-200),
      }),
    });
  }
  if (!session.hasCookie()) {
    log(`No login yet. Open http://localhost:${cfg.ui?.port ?? 8787} and follow the Connect tab.`);
    if (ONCE) process.exit(1);
    await session.waitForCookie();
    log('login received, starting');
  }
  await session.init();
  if (!cfg.myUserId) cfg.myUserId = session.readAuth()?.user?.id ?? '';
  clock = await calibrate(session);
  log(`clock: offset ${clock.offsetMs.toFixed(0)}ms (±${clock.uncertaintyMs.toFixed(0)}), rtt ${clock.rttMs}ms, ${clock.samples} samples`);
  await refreshBalance().catch((e) => log('balance:', e.message));
  await refreshWishlist();
  await poll();
  if (ONCE) return process.exit(0);
  watchConfig(cfg, log);
  startPacks({
    session, cfg, log, dry: DRY, getWishlist: () => wishlist, control, stats,
    onBalance: (nb) => {
      const gained = nb - (balance ?? nb);
      balance = nb;
      if (gained > 0) stats.earned += gained;
      return gained;
    },
  });
  startSelling({ session, cfg, log, dry: DRY, getWishlist: () => wishlist, control, stats, info: sellInfo });
  setInterval(() => refreshBalance().catch(() => {}), 5 * 60_000);
  setInterval(() => refreshWishlist().catch((e) => log(e.message)), 15_000);
  setInterval(() => poll().catch((e) => { log('poll error:', e.message); if (/token refresh failed/.test(e.message)) sessionProblem = e.message; }), T.pollSeconds * 1000);
  setInterval(async () => (clock = await calibrate(session, { durationMs: 8000 }), log(`recalibrated: offset ${clock.offsetMs.toFixed(0)}ms rtt ${clock.rttMs}ms`)), T.recalibrateMinutes * 60_000);
}

main().catch((e) => (console.error(e.message), process.exit(1)));
