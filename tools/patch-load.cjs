const fs = require('fs');
const must = (c, m) => { if (!c) throw new Error('patch failed: ' + m); };
const functionsOf = (src) => [...src.matchAll(/^\s*(?:async )?function (\w+)/gm)].map((m) => m[1]);

let b = fs.readFileSync('src/bot.js', 'utf8'); const b0 = b; let x;

// ---- 1. adaptive throttle: when the site's list requests are slow, stop scanning for a while
x = b;
b = b.replace("const control = { paused: false };", `const control = { paused: false };

/**
 * Be gentle with the site: track how long list requests take. When they get slow (over ~2.5 s on average) the
 * bot stops scanning for two minutes, so its own requests never make a struggling site slower.
 */
let listLatency = 300;
let coolUntil = 0;
let lastCoolLog = 0;
function noteLatency(ms) {
  listLatency = 0.7 * listLatency + 0.3 * ms;
  if (listLatency > 2500) coolUntil = Date.now() + 120_000;
}
const siteBusy = () => Date.now() < coolUntil;

/** Recent bid round-trip times: when the site is slow to process bids we must send earlier. */
const recentBidRtts = [];
function bidLatencyMs() {
  const cutoff = Date.now() - 30 * 60_000;
  const rtts = recentBidRtts.filter((s) => s.at > cutoff).map((s) => s.rtt).sort((p, q) => p - q);
  if (rtts.length < 2) return 0;
  return 0.8 * rtts[Math.min(rtts.length - 1, Math.floor(0.75 * rtts.length))]; // ~80% of the 75th percentile
}`);
must(b !== x, 'throttle def');

x = b;
b = b.split("const oneWay = clock.rttMs / 2 + T.extraBidLatencyMs;").join("const oneWay = Math.max(clock.rttMs / 2 + T.extraBidLatencyMs, bidLatencyMs());");
must(b !== x && !b.includes("const oneWay = clock.rttMs / 2 + T.extraBidLatencyMs;"), 'oneWay x3');

x = b;
b = b.replace("  ok ? stats.bidsOk++ : stats.bidsFailed++;", "  ok ? stats.bidsOk++ : stats.bidsFailed++;\n  if (ok) recentBidRtts.push({ at: Date.now(), rtt: r.t1 - r.t0 });");
must(b !== x, 'record rtt');

// measure list-request latency where the heavy requests are made
x = b;
b = b.replace("async function fetchPage(page) {\n  await control.quiet();\n  const r = await session.request(", "async function fetchPage(page) {\n  await control.quiet();\n  const r = await session.request(");
// (the request line in fetchPage) -> note latency right after it
b = b.replace(/(async function fetchPage\(page\) \{[\s\S]*?const r = await session\.request\([^\n]*\n)/, "$1  noteLatency(r.t1 - r.t0);\n");
must(b.includes('noteLatency(r.t1 - r.t0);'), 'fetchPage latency');
x = b;
b = b.replace("    if (Date.now() - started > (T.scanBudgetSeconds ?? 20) * 1000) break; // site is slow: soonest auctions first is enough", "    if (Date.now() - started > (T.scanBudgetSeconds ?? 20) * 1000 || siteBusy()) break; // site is slow: soonest auctions first is enough");
must(b !== x, 'list loop');
x = b;
b = b.replace("      if (r.status !== 200 || !r.json?.auctions) break;\n      for (const a of r.json.auctions) if (keep(a)) searchResults.set(a.id, { a, at: Date.now() });", "      noteLatency(r.t1 - r.t0);\n      if (r.status !== 200 || !r.json?.auctions) break;\n      for (const a of r.json.auctions) if (keep(a)) searchResults.set(a.id, { a, at: Date.now() });\n      if (siteBusy()) break;");
b = b.replace("  for (let done = 0; done < queries.length && Date.now() - started < budgetMs; done++) {", "  for (let done = 0; done < queries.length && Date.now() - started < budgetMs && !siteBusy(); done++) {");
must(b.includes('if (siteBusy()) break;') && b.includes('!siteBusy(); done++'), 'search loop');

// the scan itself: skip while cooling down
x = b;
b = b.replace("async function pollOnce(withWishlist) {\n", `async function pollOnce(withWishlist) {
  if (siteBusy()) {
    if (Date.now() - lastCoolLog > 110_000) {
      lastCoolLog = Date.now();
      log(\`site is slow (list requests average \${(listLatency / 1000).toFixed(1)}s): pausing scans for ~2 min to ease its load. Planned bids still fire.\`);
    }
    return;
  }
`);
must(b !== x, 'pollOnce cooldown');

// wishlist refresh: half as often, and not while the site is struggling
x = b;
b = b.replace("  setInterval(() => refreshWishlist().catch((e) => log(e.message)), 15_000);", "  setInterval(() => (siteBusy() ? null : refreshWishlist().catch((e) => log(e.message))), 30_000);");
must(b !== x, 'wishlist interval');

for (const f of functionsOf(b0)) must(b.includes('function ' + f), 'lost function ' + f);
fs.writeFileSync('src/bot.js', b);

// ---- config: lighter defaults
for (const f of ['config.json', 'config.example.json']) {
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  Object.assign(c.timing, { pollSeconds: 90, maxPages: 3, scanBudgetSeconds: 10, searchBudgetSeconds: 8 });
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + (f.endsWith('example.json') ? '\n' : ''));
}
console.log('load + latency patched');
