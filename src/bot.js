import fs from 'node:fs';
import { Session } from './http.js';
import { calibrate } from './clock.js';
import { auctionFacts, bidRuleMatch, decide, describe, matches, plain } from './rules.js';
import { startPacks } from './packs.js';
import { startSelling } from './sell.js';
import { startValues } from './values.js';
import { bidOnTitles, cardEvent, readCardEvents, winsSince, wonCardIds } from './history.js';
import { loadConfig, watchConfig } from './config.js';
import { startUI } from './ui.js';
import { changeTargets, readJournal, targetStatus, watchTargets } from './targets.js';
import { catalogSearch } from './discover.js';
import { cheapestPerCard } from './snipe-selection.js';
import { counterWaitMs } from './counter-timing.js';

const cfg = loadConfig();
const LIVE = process.argv.includes('--live');
const ONCE = process.argv.includes('--once');
const DRY = !LIVE || cfg.dryRun === true; // live needs BOTH --live and dryRun:false
const T = cfg.timing;
const LOG = new URL('../bids.jsonl', import.meta.url);

Session.allowRenewal = true; // this process is the one that keeps the login renewed
const session = new Session();
session.onLog = (m) => log(m);
if (!cfg.myUserId) cfg.myUserId = session.readAuth()?.user?.id ?? '';
const plans = new Map(); // auctionId -> { endAt, timer, rule, amount }
const recentBids = []; // local timestamps of sent bids
let clock = { offsetMs: 0, rttMs: 300, uncertaintyMs: 1000 };
let balance = null;
let sessionProblem = null;
let values = { getValues: () => ({ cards: [], owned: 0, priced: 0, pending: 0, noHistory: 0, totalValue: 0 }), sell: async () => ({ ok: false, error: 'still starting up' }), refreshAll: () => ({ ok: false, error: 'still starting up' }) };
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

/** The target list (targets.json) and hard limits (limits.json), re-read when the files change. */
const book = watchTargets(log);
const tmap = () => (cfg.targets?.enabled === false ? new Map() : book.active());
/** Auctions for active targets seen in the last scan, used to save money for higher-priority targets. */
let targetAuctions = new Map(); // auction id -> { a, t }
/** Wins over the last 8 days, for the weekly limit and theme budgets (kept across restarts in cards.jsonl). */
const wins = winsSince(Date.now() - 8 * 86400_000);
const WEEK = 7 * 86400_000;
const spentSince = (ms, theme) => wins.filter((w) => w.at >= ms && (theme === undefined || w.theme === theme)).reduce((s, w) => s + w.price, 0);

/**
 * Be gentle with the site: track how long list requests take. When they get slow (over ~2.5 s on average) the
 * bot stops scanning for two minutes, so its own requests never make a struggling site slower.
 */
let listLatency = 300;
function noteLatency(ms) {
  listLatency = 0.7 * listLatency + 0.3 * ms;
}
// Requests are strictly one at a time, so the bot never piles load on the site. Pausing scans when the site is
// slow stopped the bot from finding anything (the site is often slow for long stretches), so scans always run.
const siteBusy = () => false;

/** Recent bid round-trip times: when the site is slow to process bids we must send earlier. */
const recentBidRtts = [];
function bidLatencyMs() {
  const cutoff = Date.now() - 30 * 60_000;
  const rtts = recentBidRtts.filter((s) => s.at > cutoff).map((s) => s.rtt).sort((p, q) => p - q);
  if (rtts.length < 2) return 0;
  return 0.8 * rtts[Math.min(rtts.length - 1, Math.floor(0.75 * rtts.length))]; // ~80% of the 75th percentile
}

/** Cards the bot won by bidding (remembered across restarts), plus why a card must never be sold or recycled. */
const wonIds = wonCardIds();
const bidTitles = bidOnTitles(); // older wins, from before the card history existed
const protectedBy = (facts) => {
  if (wonIds.has(facts.cardId)) return 'bought by a bid rule';
  if (bidTitles.has(facts.title)) return 'the bot bid on this card';
  if (book.isTarget(facts.cardId)) return 'on the target list';
  const rule = bidRuleMatch(cfg, facts, wishlist);
  return rule ? `matches bid rule "${rule}"` : null;
};

/** True in the seconds around a snipe (one about to fire) and while we are following an auction we bid on. */
const sniping = () => {
  const now = Date.now();
  for (const p of plans.values()) if (p.fireAt - now < 25_000 && p.fireAt - now > -6_000) return true;
  return watching.size > 0;
};
/** Background chores (scans, packs, recycling, selling) await this before each request. */
control.quiet = async () => {
  for (let i = 0; i < 400 && sniping(); i++) await sleep(250);
};

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
const packInfo = { blocked: null, lastOpenedAt: null };
let packsCtl = { retryNow: () => ({ ok: false, error: 'still starting up' }) };
const sellInfo = { active: 0, max: 5, preview: [], lastRunAt: null };
const pendingBids = new Map(); // auction id -> { title, amount } for bids whose auction has not finished
let startBalance = null;
const startedAt = Date.now();
const record = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverNow = () => Date.now() + clock.offsetMs;
const jitter = () => (Math.random() * 2 - 1) * T.jitterMs;

async function fetchPage(page) {
  await control.quiet();
  const r = await session.request('GET', `/api/marketplace?page=${page}&limit=50&sort=ending_soon`);
  noteLatency(r.t1 - r.t0);
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
  const started = Date.now();
  for (let p = 1; p <= maxPages; p++) {
    const j = await fetchPage(p);
    // After a wave of auctions ends, the first pages are full of ended-but-unsettled auctions: skip them.
    const now = Date.now() + clock.offsetMs;
    out.push(...j.auctions.filter((a) => Date.parse(a.end_at) > now));
    if (!j.hasMore || !j.auctions.length || Date.parse(j.auctions.at(-1).end_at) > horizon) break;
    if (Date.now() - started > (T.scanBudgetSeconds ?? 20) * 1000) break; // site is slow: soonest auctions first is enough
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
  lastWishlistAt = Date.now();
  log(`wishlist: ${wishlist.size} cards`);
}
let lastWishlistAt = null;
let wishlistLoading = false;

/** Dashboard buttons: reload the wishlist, or run an auction scan now instead of waiting for the next one. */
async function scanNow(what) {
  if (what === 'wishlist') {
    if (wishlistLoading) return { ok: false, error: 'the wishlist is already being reloaded' };
    wishlistLoading = true;
    try {
      await refreshWishlist();
      return { ok: true, done: `${wishlist.size} cards` };
    } finally {
      wishlistLoading = false;
    }
  }
  if (what === 'auctions') {
    if (polling) return { ok: false, error: 'a scan is already running' };
    log('scan requested from the dashboard');
    await poll();
    return { ok: true, done: lastScanSummary };
  }
  return { ok: false, error: 'unknown scan' };
}

/**
 * Add or remove a card on the site's wishlist (a Supabase table the site's page writes to directly), then update
 * the bot's copy right away so rules and the auction search use it without waiting for the next refresh.
 */
async function setWishlisted(cardId, on, title) {
  if (!/^[0-9a-f-]{36}$/i.test(cardId ?? '')) return { ok: false, error: 'bad card id' };
  const uid = cfg.myUserId || session.readAuth()?.user?.id;
  if (!uid) return { ok: false, error: 'not logged in' };
  const r = on
    ? await session.supabase('POST', 'wishlist_items', { user_id: uid, card_id: cardId })
    : await session.supabase('DELETE', `wishlist_items?user_id=eq.${uid}&card_id=eq.${cardId}`);
  // 409 on add = it was already on the wishlist
  if ((r.status < 200 || r.status > 299) && !(on && r.status === 409)) {
    return { ok: false, error: `HTTP ${r.status}${r.json?.message ? ': ' + r.json.message : ''}` };
  }
  wishlist = new Set(wishlist);
  if (on) {
    wishlist.add(cardId);
    if (title && !wishlistTitles.includes(title)) wishlistTitles = [...wishlistTitles, title];
  } else wishlist.delete(cardId); // its title leaves the search at the next refresh
  log(`wishlist: ${on ? 'added' : 'removed'} ${title ?? cardId} (${wishlist.size} cards)`);
  return { ok: true, on };
}

/** The marketplace is huge, so find wishlist auctions by title search and match on card id. */
const searchResults = new Map(); // auction id -> { a, at }, kept between scans
let searchCursor = 0;
let urgentCursor = 0;

/**
 * Find auctions for wishlist cards and keyword rules by title search. Each title is a heavy request, so the
 * titles are worked through in slices with a time budget per scan (searchBudgetSeconds); when the site is slow
 * we get through fewer titles per scan instead of piling requests on top of each other.
 */
async function wishlistAuctions() {
  // The site's search does not match the "(qualifier)" part of a title, so search on the text before it.
  // query text -> which results to keep. Wishlist titles keep wishlist cards; a rule's "titleContains" keeps titles containing it.
  const searchPage = async (q, keep, maxPages) => {
    for (let p = 1; p <= maxPages; p++) {
      await control.quiet();
      const r = await session.request('GET', `/api/marketplace?page=${p}&limit=50&sort=ending_soon&q=${encodeURIComponent(q)}`);
      noteLatency(r.t1 - r.t0);
      if (r.status !== 200 || !r.json?.auctions) break;
      for (const a of r.json.auctions) if (keep(a)) searchResults.set(a.id, { a, at: Date.now() });
      if (!r.json.hasMore) break;
    }
  };
  // Rules with a search ("search", or "title contains") are few and matter most: search them on EVERY scan,
  // before the wishlist. The site's search covers each card's title AND category, so "jeu vidéo" finds video games.
  const keywords = new Set();
  for (const rule of cfg.rules) {
    if (rule.enabled === false || rule.skip) continue;
    const kw = rule.search || rule.when?.titleContains;
    if (kw && !keywords.has(kw)) {
      keywords.add(kw);
      await searchPage(kw, (a) => matches(rule.when, auctionFacts(a), wishlist), 3);
    }
  }
  // Target and wishlist titles. Priority-1 targets are searched on every scan (up to targets.searchEveryScan of
  // them); the other targets, then the wishlist, share a time-budgeted slice per scan, continuing where the last
  // scan stopped.
  const targets = tmap();
  const wanted = (a) => wishlist.has(a.card_id) || targets.has(a.card_id);
  const q = (t) => t.split('(')[0].trim() || t;
  const urgent = [...new Set([...targets.values()].filter((t) => t.priority === 1).map((t) => q(t.title)))].filter((x) => !keywords.has(x));
  const rest = [
    ...[...targets.values()].sort((x, y) => x.priority - y.priority).map((t) => q(t.title)),
    ...wishlistTitles.map(q),
  ].filter((x, i, all) => !keywords.has(x) && !urgent.includes(x) && all.indexOf(x) === i);
  const budgetMs = (T.searchBudgetSeconds ?? 20) * 1000;
  const started = Date.now();
  const searchTitle = async (query) => {
    const maxPages = query.length < 4 ? 20 : 8; // very short queries match a lot of auctions
    for (let p = 1; p <= maxPages && Date.now() - started < budgetMs * 2; p++) {
      await control.quiet();
      const r = await session.request('GET', `/api/marketplace?page=${p}&limit=50&sort=ending_soon&q=${encodeURIComponent(query)}`);
      noteLatency(r.t1 - r.t0);
      if (r.status !== 200 || !r.json?.auctions) break;
      for (const a of r.json.auctions) if (wanted(a)) searchResults.set(a.id, { a, at: Date.now() });
      if (siteBusy()) break;
      if (!r.json.hasMore) break;
    }
  };
  const everyScan = Math.min(urgent.length, cfg.targets?.searchEveryScan ?? 8);
  for (let done = 0; done < everyScan && Date.now() - started < budgetMs; done++) await searchTitle(urgent[urgentCursor++ % urgent.length]);
  for (let done = 0; done < rest.length && Date.now() - started < budgetMs && !siteBusy(); done++) await searchTitle(rest[searchCursor++ % rest.length]);
  // forget auctions that have ended or were last seen a long time ago
  const now = serverNow();
  for (const [id, v] of searchResults) if (Date.parse(v.a.end_at) < now || Date.now() - v.at > 50 * 60_000) searchResults.delete(id);
  return [...searchResults.values()].map((v) => v.a);
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

function heldInBids(exceptAuctionId, theme) {
  let sum = 0;
  for (const [id, p] of pendingBids) if (id !== exceptAuctionId && (theme === undefined || p.theme === theme)) sum += p.amount;
  return sum;
}

/**
 * Money to keep for higher-priority targets whose auctions end within targets.reserveHorizonHours: each one's max
 * bid, as far as it is affordable. A target we could not pay for even at today's price is not saved for (that would
 * block every other bid without ever winning it). Rule bids count as lower priority than every target. Auctions we
 * already bid on are not counted (that money is already held by the site).
 */
function savedForHigherPriority(decision, auctionId, spendable) {
  const mine = decision?.target ? decision.priority : 99;
  const until = serverNow() + (cfg.targets?.reserveHorizonHours ?? 3) * 3600_000;
  let total = 0;
  const titles = [];
  for (const [id, { a, t, amount }] of targetAuctions) {
    if (id === auctionId || t.priority >= mine || pendingBids.has(id)) continue;
    const end = Date.parse(a.end_at);
    if (end < serverNow() || end > until) continue;
    if (amount > spendable - total) continue; // out of reach right now
    total += Math.min(t.maxBid, spendable - total);
    titles.push(t.title);
  }
  return { total, titles };
}

function committedToday(exceptAuctionId) {
  const day = new Date().toISOString().slice(0, 10);
  if (spentToday.day !== day) spentToday = { day, won: 0 };
  return spentToday.won + heldInBids(exceptAuctionId);
}

function budgetOk(amount, { skipGap = false, auctionId, counter = false, decision } = {}) {
  const now = Date.now();
  const L = book.limits();
  while (recentBids.length && now - recentBids[0] > 3600_000) recentBids.shift();
  // counter-bids are already limited per auction (global.counters), so the hourly cap only applies to new snipes
  if (!counter && recentBids.length >= cfg.global.maxSnipesPerHour) return 'hourly snipe cap';
  if (!skipGap && !counter && now - lastBidAt < cfg.global.minGapBetweenBidsMs) return 'min gap between bids';
  if (L.maxBidPerCard != null && amount > L.maxBidPerCard) return `hard limit: ${amount} > maxBidPerCard ${L.maxBidPerCard}`;
  const committed = committedToday(auctionId);
  if (committed + amount > cfg.global.dailySpendCap) return `daily spend cap (${committed} already won or held + ${amount} > ${cfg.global.dailySpendCap})`;
  if (L.maxDailySpend != null && committed + amount > L.maxDailySpend) return `hard limit: daily spend (${committed} won or held + ${amount} > ${L.maxDailySpend})`;
  if (L.maxWeeklySpend != null) {
    const week = spentSince(now - WEEK) + heldInBids(auctionId);
    if (week + amount > L.maxWeeklySpend) return `hard limit: weekly spend (${week} won or held in 7 days + ${amount} > ${L.maxWeeklySpend})`;
  }
  const theme = decision?.theme;
  const budget = theme ? book.data().themes[theme]?.weeklyBudget : null;
  if (budget != null) {
    const used = spentSince(now - WEEK, theme) + heldInBids(auctionId, theme);
    if (used + amount > budget) return `theme "${theme}" budget (${used} of ${budget} used in 7 days, this bid ${amount})`;
  }
  const reserve = Math.max(cfg.global.reserveBalance, L.minReserve ?? 0);
  const saved = savedForHigherPriority(decision, auctionId, balance === null ? Infinity : balance - reserve);
  if (balance !== null && amount > balance - reserve - saved.total) {
    return saved.total
      ? `balance ${balance}: keeping ${reserve} reserve + ${saved.total} for higher-priority targets ending soon (${saved.titles.slice(0, 3).join(', ')}${saved.titles.length > 3 ? '…' : ''})`
      : `balance ${balance} (reserve ${reserve})`;
  }
  return null;
}

function schedule(a, decision) {
  const endMs = Date.parse(a.end_at);
  const oneWay = Math.max(clock.rttMs / 2 + T.extraBidLatencyMs, bidLatencyMs());
  // Local time at which to send so the server receives the bid ~targetRemainingMs before end.
  const fireAt = endMs - T.targetRemainingMs - oneWay - clock.offsetMs + jitter();
  const prev = plans.get(a.id);
  if (prev) clearTimeout(prev.timer);
  const wait = fireAt - Date.now();
  if (wait < -1000) {
    plans.delete(a.id);
    return void log(`skip (too late by ${(-wait / 1000).toFixed(1)}s): ${describe(a)}`);
  }

  // re-check early enough for a slow site: ~2 list requests' worth of time before firing
  const preAt = Math.max(0, wait - Math.max(T.preCheckLeadMs, clock.rttMs * 2 + 1500, listLatency * 2 + 2000));
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
  // The re-check must never make us miss the snipe: if the site has not answered by the time we should fire,
  // fire on the plan we already have.
  const lookup = Promise.all([getAuction(id), refreshBalance().catch(() => {})]).then(([fresh]) => fresh);
  try {
    const fresh = await Promise.race([lookup, sleep(Math.max(0, plan.fireAt - Date.now() - 150)).then(() => null)]);
    if (fresh) a = fresh;
    else log(`re-check still waiting on the site; firing on the plan: ${describe(a)}`);
  } catch (e) {
    log(`preCheck lookup failed (${e.message}); firing on the original plan`);
  }
  if (plans.get(id) !== plan) return; // a later scan chose a cheaper auction for this card
  if (a.status !== 'active') return void (plans.delete(id), log(`auction ${id} not active (${a.status})`));
  const d = decide(cfg, a, cfg.myUserId, wishlist, tmap());
  if (d.action !== 'bid') return void (plans.delete(id), log(`drop ${describe(a)}: ${d.reason}`));
  if (a.end_at !== plan.endAt) log(`end time moved ${plan.endAt} -> ${a.end_at}`);
  try {
    await fireWhenReady(a, d, plan);
  } catch (e) {
    log(`snipe failed on ${describe(a)}: ${e.message}`);
  } finally {
    if (plans.get(id) === plan) plans.delete(id);
  }
}

async function fireWhenReady(a, decision, plan) {
  const endMs = Date.parse(a.end_at);
  const oneWay = Math.max(clock.rttMs / 2 + T.extraBidLatencyMs, bidLatencyMs());
  const fireAt = endMs - T.targetRemainingMs - oneWay - clock.offsetMs + jitter();
  let wait = fireAt - Date.now();
  if (wait < -500) {
    // Late (slow site). Bidding late only extends the auction, which beats not bidding at all.
    if (endMs - serverNow() < 2500) return void (plans.delete(a.id), log(`missed: auction ending in under 2.5s: ${describe(a)}`));
    log(`running ${(-wait / 1000).toFixed(1)}s late (slow site), bidding anyway: ${describe(a)}`);
    if (plans.get(a.id) !== plan) return;
    return void (await placeBid(a, decision, fireAt));
  }
  if (wait > 30) await sleep(wait - 25);
  while (Date.now() < fireAt) {} // spin for the last few ms
  if (plans.get(a.id) !== plan) return;
  await placeBid(a, decision, fireAt);
}

const watching = new Set(); // auctions we have bid on and are still following

/** Counter-bids allowed on an auction we already bid on: the rule's or target's setting, else the global default. */
const countersFor = (decision) => decision.counters ?? cfg.global.counters ?? 2;

/**
 * Follow an auction after our bid. If someone outbids us, queue a new snipe (as long as the rules still
 * allow the new price); when the auction has ended, record whether we won or were outbid.
 */
async function watchAuction(a, amount, decision) {
  const ruleName = decision.rule;
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
          wonIds.add(a.card_id);
          wins.push({ at: Date.now(), price: cur.final_price ?? amount, theme: decision.theme ?? null, cardId: a.card_id, title });
          cardEvent('won', { cardId: a.card_id, title, rarity: a.snapshot_rarity, price: cur.final_price ?? amount, rule: ruleName, ...(decision.theme ? { theme: decision.theme } : {}) });
          log(`WON ${title} for ${cur.final_price ?? amount}`);
        } else {
          stats.lost++;
          // kept so the prices cards really go for can be looked up later (Cards tab, npm run agent)
          cardEvent('lost', { cardId: a.card_id, title, rarity: a.snapshot_rarity, price: cur.final_price ?? cur.current_bid, myBid: amount, rule: ruleName, ...(decision.theme ? { theme: decision.theme } : {}) });
          log(`OUTBID on ${title}: lost at ${cur.final_price ?? cur.current_bid} (my bid refunded)`);
        }
        refreshBalance().catch(() => {});
        return;
      }
      if (cur.current_bidder_id && cur.current_bidder_id !== cfg.myUserId && cur.current_bid !== lastRival) {
        lastRival = cur.current_bid;
        log(`someone bid ${cur.current_bid} on ${title} after us`);
        if (counters >= countersFor(decision)) {
          log(`no more counters for ${title} (limit ${countersFor(decision)})`);
          continue;
        }
        const d = decide(cfg, cur, cfg.myUserId, wishlist, tmap());
        if (d.action !== 'bid') {
          log(`not countering ${title}: ${d.reason}`);
          continue;
        }
        counters++;
        queueCounter(cur, d);
      }
    }
  } finally {
    clearTimeout(counterTimers.get(a.id));
    counterTimers.delete(a.id);
    watching.delete(a.id);
    pendingBids.delete(a.id);
  }
}

/** Schedule a counter for the normal lead time, or send now if that time has passed. */
const counterTimers = new Map(); // auction id -> the one queued counter (a newer outbid replaces it)

function queueCounter(cur, decision) {
  clearTimeout(counterTimers.get(cur.id));
  const oneWay = Math.max(clock.rttMs / 2 + T.extraBidLatencyMs, bidLatencyMs());
  const msLeft = Date.parse(cur.end_at) - serverNow();
  const wait = counterWaitMs(msLeft, T.targetRemainingMs, oneWay, jitter());
  if (wait === 0) log(`counter target already passed on ${cur.card?.wikipedia_title}; bidding immediately (${(msLeft / 1000).toFixed(1)}s left)`);
  log(`COUNTER queued: ${describe(cur)} bid=${decision.amount} in ${(wait / 1000).toFixed(1)}s (target ${(T.targetRemainingMs / 1000).toFixed(1)}s before the end)`);
  counterTimers.set(cur.id, setTimeout(async () => {
    counterTimers.delete(cur.id);
    try {
      // The watcher just read this auction and will replace this timer if a newer rival bid appears.
      // A lookup here can consume the whole lead time when the site is slow.
      const d = decide(cfg, cur, cfg.myUserId, wishlist, tmap());
      if (d.action !== 'bid') return void log(`counter dropped for ${cur.card?.wikipedia_title}: ${d.reason}`);
      await placeBid(cur, d, Date.now(), { counter: true });
    } catch (e) {
      log('counter error:', e.message);
    }
  }, wait));
}

async function placeBid(a, decision, fireAt, { counter = false } = {}) {
  if (control.paused) {
    plans.delete(a.id);
    return void log(`PAUSED: skipped bid ${decision.amount} on ${describe(a)}`);
  }
  const why = budgetOk(decision.amount, { auctionId: a.id, counter, decision });
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
    const max = decision.max ?? 0;
    const why2 = r.json.min > max ? `minimum ${r.json.min} is above this ${decision.target ? 'target' : 'rule'}'s max ${max}` : budgetOk(r.json.min, { skipGap: true, auctionId: a.id, counter, decision });
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
  if (ok) recentBidRtts.push({ at: Date.now(), rtt: r.t1 - r.t0 });
  if (ok && a.card?.wikipedia_title) bidTitles.add(a.card.wikipedia_title);
  if (ok) {
    pendingBids.set(a.id, { cardId: a.card_id, title: a.card?.wikipedia_title, amount: decision.amount, theme: decision.theme ?? null });
    watchAuction(a, decision.amount, decision).catch(() => pendingBids.delete(a.id));
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

let polling = false;

async function poll(withWishlist = true) {
  if (polling) return; // a scan is still running: do not start another on top of it
  polling = true;
  try {
    await pollOnce(withWishlist);
  } finally {
    polling = false;
  }
}

async function pollOnce(withWishlist) {
  for (const [id, plan] of plans) {
    if (Date.parse(plan.endAt) >= serverNow()) continue;
    clearTimeout(plan.timer);
    plans.delete(id);
  }
  const near = await listAuctions();
  const wl = withWishlist ? await wishlistAuctions() : [];
  const wlIds = new Set(wl.map((a) => a.id));
  const list = [...new Map([...near, ...wl].map((a) => [a.id, a])).values()];
  lastScan = list;
  const horizon = serverNow() + T.horizonMinutes * 60_000;
  let planned = 0;
  const targets = tmap();
  const targetCandidates = [];
  for (const a of list) {
    const t = targets.get(a.card_id);
    if (!t || Date.parse(a.end_at) <= serverNow()) continue;
    const d = decide(cfg, a, cfg.myUserId, wishlist, targets);
    if (d.action === 'bid') targetCandidates.push({ auction: a, decision: d });
  }
  targetAuctions = new Map(cheapestPerCard(targetCandidates).map(({ auction: a, decision: d }) => [a.id, { a, t: targets.get(a.card_id), amount: d.amount }]));
  const pendingCardIds = new Set([...pendingBids.values()].map((p) => p.cardId));
  const candidates = new Map();
  const seenIds = new Set(list.map((a) => a.id));
  // Keep plans found in earlier scans when their auction is absent from this scan.
  for (const [id, p] of plans) {
    if (seenIds.has(id) || pendingCardIds.has(p.auction.card_id)) continue;
    const d = decide(cfg, p.auction, cfg.myUserId, wishlist, targets);
    if (d.action === 'bid') candidates.set(id, { auction: p.auction, decision: d });
  }
  for (const a of list) {
    const endMs = Date.parse(a.end_at);
    if ((endMs > horizon && !wlIds.has(a.id)) || endMs < serverNow()) continue;
    if (pendingCardIds.has(a.card_id)) continue;
    const oneWay = Math.max(clock.rttMs / 2 + T.extraBidLatencyMs, bidLatencyMs());
    if (!plans.has(a.id) && endMs - T.targetRemainingMs - oneWay - clock.offsetMs < Date.now() - 1000) continue;
    const d = decide(cfg, a, cfg.myUserId, wishlist, targets);
    if (d.action !== 'bid') continue;
    if (watching.has(a.id)) continue;
    candidates.set(a.id, { auction: a, decision: d });
  }
  const chosen = cheapestPerCard(candidates.values());
  const chosenIds = new Set(chosen.map(({ auction }) => auction.id));
  for (const [id, p] of plans) {
    if (chosenIds.has(id)) continue;
    clearTimeout(p.timer);
    plans.delete(id);
    log(`drop duplicate or ineligible plan: ${describe(p.auction)}`);
  }
  for (const { auction: a, decision: d } of chosen) {
    const prev = plans.get(a.id);
    if (prev && prev.endAt === a.end_at) {
      prev.auction = a;
      prev.amount = d.amount;
      prev.rule = d.rule;
      continue;
    }
    schedule(a, d);
    planned++;
  }
  lastScanAt = Date.now();
  lastScanSummary = `${list.length} auctions, ${planned} newly planned`;
  log(`poll: ${list.length} upcoming auctions (${wl.length} from searches), ${planned} newly planned, ${plans.size} active plans, site ~${(listLatency / 1000).toFixed(1)}s per request`);
}
let lastScanAt = null;
let lastScanSummary = '';

let lastScan = []; // auctions seen in the last scan (ending soon + searches)

/**
 * Everything needed to judge how the targets are doing, in one read: money and limits, spend per theme over the
 * last 7 days, each target with its auction (if one is running), recent wins and losses. Used by the Targets tab and
 * `npm run agent -- status`.
 */
function getReport() {
  const now = Date.now();
  const d = book.data();
  const L = book.limits();
  const v = values.getValues();
  const ownedIds = new Set(v.cards.map((c) => c.cardId));
  const active = tmap();
  const auctionOf = new Map();
  for (const a of lastScan) {
    const prev = auctionOf.get(a.card_id);
    if (!prev || Date.parse(a.end_at) < Date.parse(prev.end_at)) auctionOf.set(a.card_id, a);
  }
  for (const p of plans.values()) auctionOf.set(p.auction.card_id, p.auction);
  const themes = Object.entries(d.themes).map(([name, th]) => {
    const spent = spentSince(now - WEEK, name);
    const held = heldInBids(undefined, name);
    const inTheme = d.targets.filter((t) => t.theme === name);
    return {
      name, ...th, spent7d: spent, held, left: th.weeklyBudget == null ? null : Math.max(0, th.weeklyBudget - spent - held),
      targets: inTheme.length, owned: inTheme.filter((t) => ownedIds.has(t.cardId)).length,
    };
  });
  const targets = d.targets.map((t) => {
    const a = auctionOf.get(t.cardId);
    return {
      ...t, status: targetStatus(t, d, now), owned: ownedIds.has(t.cardId), effectiveMaxBid: active.get(t.cardId)?.maxBid ?? null,
      auction: a && Date.parse(a.end_at) > serverNow()
        ? { id: a.id, price: a.effective_bid ?? a.current_bid ?? a.base_amount, endsAt: a.end_at, leading: a.current_bidder_id === cfg.myUserId || pendingBids.has(a.id), planned: plans.has(a.id) }
        : null,
    };
  });
  const results = readCardEvents({ sinceMs: now - WEEK, limit: 2000 }).events.filter((e) => e.type === 'won' || e.type === 'lost');
  return {
    at: new Date(now).toISOString(),
    mode: DRY ? 'dry-run' : 'live',
    paused: control.paused,
    connected: session.hasCookie() && !sessionProblem,
    sessionProblem,
    uptimeSec: Math.round((now - startedAt) / 1000),
    targetsEnabled: cfg.targets?.enabled !== false,
    balance,
    reserve: Math.max(cfg.global.reserveBalance, L.minReserve ?? 0),
    limits: L,
    spend: {
      today: committedToday(), dailySpendCap: cfg.global.dailySpendCap,
      last7days: spentSince(now - WEEK), heldInBids: heldInBids(),
      noTheme7days: wins.filter((w) => w.at >= now - WEEK && !w.theme).reduce((s, w) => s + w.price, 0),
    },
    themes,
    targets,
    collection: { known: v.ownedAt > 0, cards: v.owned, totalValue: Math.round(v.totalValue ?? 0) },
    plans: [...plans.entries()].map(([id, p]) => ({ id, title: p.auction?.card?.wikipedia_title, rarity: p.auction?.snapshot_rarity, amount: p.amount, rule: p.rule, endAt: p.endAt })),
    last7days: {
      won: results.filter((e) => e.type === 'won').length,
      lost: results.filter((e) => e.type === 'lost').length,
      events: results.slice(0, 40).map(({ at, type, title, rarity, price, myBid, rule, theme }) => ({ at, type, title, rarity, price, myBid, rule, theme })),
    },
  };
}

async function main() {
  log(`mode: ${DRY ? 'DRY-RUN (pass --live to place real bids)' : 'LIVE'}`);
  if (!ONCE && cfg.ui?.enabled !== false) {
    startUI({
      port: cfg.ui?.port ?? 8787,
      control,
      log,
      session,
      getValues: () => {
        const v = values.getValues();
        return { ...v, cards: v.cards.map((c) => ({ ...c, onWishlist: wishlist.has(c.cardId) })) };
      },
      getWishlist: () => wishlist,
      setWishlisted,
      getReport,
      getIds: () => ({ owned: values.getValues().cards.map((c) => c.cardId), ownedKnown: values.getValues().ownedAt > 0, wishlist: [...wishlist], targets: book.data().targets.map((t) => t.cardId) }),
      changeTargets: (ops, by) => {
        const done = changeTargets(ops, { by });
        book.reload();
        log(`targets changed by ${by}: ${done.join('; ')}`);
        return done;
      },
      readJournal,
      catalog: (opts) => catalogSearch(session, opts),
      // Only when started by tools/supervise.cjs (start-bot.bat), which starts the bot again right after it exits.
      restart: process.env.WM_SUPERVISED === '1'
        ? (why) => (log(`RESTART requested${why ? ': ' + why : ''}`), setTimeout(() => process.exit(0), 500), { ok: true })
        : () => ({ ok: false, error: 'the bot was not started by start-bot.bat (the supervisor), so nothing would start it again' }),
      sellCard: (cardId, opts) => values.sell(cardId, opts),
      scanNow,
      refreshValues: () => values.refreshAll(),
      retryPacks: () => packsCtl.retryNow(),
      refreshValue: (cardId) => values.refreshOne(cardId),
      recycleCard: async (cardId, opts) => {
        const r = await values.recycle(cardId, opts);
        if (r.ok) balance = r.balance;
        return r;
      },
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
        scan: { running: polling, lastAt: lastScanAt, summary: lastScanSummary, everySec: T.pollSeconds, wishlistLoading, wishlistAt: lastWishlistAt },
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
        packs: {
          enabled: cfg.packs.enabled,
          blocked: packInfo.blocked && packInfo.blocked.until > Date.now() ? packInfo.blocked : null,
          lastOpenedAt: packInfo.lastOpenedAt,
        },
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
  for (;;) {
    // the site can be slow or answer 5xx: keep trying instead of exiting
    try {
      await refreshWishlist();
      break;
    } catch (e) {
      log(`${e.message}; retrying in 15s`);
      await sleep(15_000);
    }
  }
  await poll().catch((e) => log('first scan failed:', e.message));
  if (ONCE) return process.exit(0);
  watchConfig(cfg, log);
  packsCtl = startPacks({
    session, cfg, log, dry: DRY, getWishlist: () => wishlist, control, stats, isProtected: protectedBy,
    info: packInfo,
    valueOf: (cardId, rarity) => (values.averageOf ? values.averageOf(cardId, rarity) : Promise.resolve(null)),
    onBalance: (nb) => {
      const gained = nb - (balance ?? nb);
      balance = nb;
      if (gained > 0) stats.earned += gained;
      return gained;
    },
  });
  startSelling({ session, cfg, log, dry: DRY, getWishlist: () => wishlist, control, stats, info: sellInfo, isProtected: protectedBy });
  values = startValues({ session, log, control, isProtected: protectedBy, cfg });
  setInterval(() => refreshBalance().catch(() => {}), 5 * 60_000);
  setInterval(() => (siteBusy() ? null : refreshWishlist().catch((e) => log(e.message))), 30_000);
  setInterval(() => poll().catch((e) => { log('poll error:', e.message); if (/token refresh failed/.test(e.message)) sessionProblem = e.message; }), T.pollSeconds * 1000);
  setInterval(async () => (clock = await calibrate(session, { durationMs: 8000 }), log(`recalibrated: offset ${clock.offsetMs.toFixed(0)}ms rtt ${clock.rttMs}ms`)), T.recalibrateMinutes * 60_000);
}

// A stray failed request must never take the bot down: log it and carry on.
process.on('unhandledRejection', (e) => log('unhandled error:', e?.message ?? e));
process.on('uncaughtException', (e) => log('uncaught error:', e?.message ?? e));

main().catch((e) => (console.error(e.message), process.exit(1)));
