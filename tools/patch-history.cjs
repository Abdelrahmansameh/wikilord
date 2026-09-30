const fs = require('fs');
const must = (c, m) => { if (!c) throw new Error('patch failed: ' + m); };
const functionsOf = (src) => [...src.matchAll(/^\s*(?:async )?function (\w+)/gm)].map((m) => m[1]);
function guard(before, after, file) {
  for (const f of functionsOf(before)) must(after.includes('function ' + f), `${file}: lost function ${f}`);
}

// ================= rules.js: which bid rule (if any) an owned card matches
let r = fs.readFileSync('src/rules.js', 'utf8'); let x = r;
r = r.replace("/** Returns { action: 'recycle' | 'keep', rule }.", `/**
 * Name of the first enabled bid rule whose card conditions this owned card meets, else null. Such cards are
 * ones the bot would bid on, so it never sells or recycles them. Price conditions are ignored (an owned card has
 * no auction price), and a rule left with no other condition is ignored so it cannot protect everything.
 */
export function bidRuleMatch(cfg, facts, wishlist = new Set()) {
  for (const rule of cfg.rules) {
    if (rule.enabled === false || rule.skip) continue;
    const { minPrice, maxCurrentPrice, ...when } = rule.when ?? {};
    if (!Object.keys(when).length) continue;
    if (matches(when, facts, wishlist)) return rule.name;
  }
  return null;
}

/** Returns { action: 'recycle' | 'keep', rule }.`);
must(r !== x && r.includes('export function bidRuleMatch'), 'rules');
fs.writeFileSync('src/rules.js', r);

// ================= packs.js: history events + protection
let p = fs.readFileSync('src/packs.js', 'utf8'); const p0 = p;
p = p.replace("import { fetchMyListings } from './sell.js';", "import { fetchMyListings } from './sell.js';\nimport { cardEvent } from './history.js';");
p = p.replace("control = { paused: false }, stats = {}, onBalance }) {", "control = { paused: false }, stats = {}, onBalance, isProtected = () => null }) {");
// recycling decision with protection + the rule that decided
p = p.replace("  const shouldRecycle = (facts) => decideRecycle(R, facts, getWishlist()).action === 'recycle';",
`  /** { recycle, rule, protectedBy }: cards bought by bid rules, or matching a bid rule, are never recycled. */
  const recycleDecision = (facts) => {
    const protectedBy = isProtected(facts);
    if (protectedBy) return { recycle: false, rule: null, protectedBy };
    const d = decideRecycle(R, facts, getWishlist());
    return { recycle: d.action === 'recycle', rule: d.rule, protectedBy: null };
  };`);
// discard logs a history event
p = p.replace("  async function discard(userCardId, label) {\n    const r = await session.request('POST', `/api/user-cards/${userCardId}/discard`);",
  "  async function discard(it) {\n    const userCardId = it.id;\n    const label = it.label;\n    const r = await session.request('POST', `/api/user-cards/${userCardId}/discard`);");
p = p.replace("      onBalance?.(r.json.balance);\n      log(`recycled ${label} -> balance ${r.json.balance}`);",
  "      const gained = onBalance?.(r.json.balance);\n      cardEvent('recycled', { cardId: it.cardId, title: it.title, rarity: it.rarity, rule: it.rule, gained, balance: r.json.balance });\n      log(`recycled ${label} -> balance ${r.json.balance}`);");
p = p.replace("      if (!(await discard(it.id, it.label))) break;", "      if (!(await discard(it))) break;");
// pack path
p = p.replace("      const ok = shouldRecycle(ownedFacts({ card: c, cardId: o.card_id, shiny: o.is_shiny, starred: o.starred, tagged: (o.user_card_tags ?? []).length > 0 }));\n      if (ok) items.push({ id: o.id, label: `${c.wikipedia_title} [${c.rarity}]` });",
  "      const d = recycleDecision(ownedFacts({ card: c, cardId: o.card_id, shiny: o.is_shiny, starred: o.starred, tagged: (o.user_card_tags ?? []).length > 0 }));\n      if (d.recycle) items.push({ id: o.id, cardId: o.card_id, title: c.wikipedia_title, rarity: c.rarity, rule: d.rule, label: `${c.wikipedia_title} [${c.rarity}]` });");
// sweep path
p = p.replace("          const ok = shouldRecycle(ownedFacts({ card: e.card, cardId: e.card_id, shiny: e.is_shiny, starred: e.starred, tagged: (e.tags ?? []).length > 0 }));\n          if (ok) items.push({ id: e.id, label: `${e.card.wikipedia_title} [${e.card.rarity}]` });",
  "          const d = recycleDecision(ownedFacts({ card: e.card, cardId: e.card_id, shiny: e.is_shiny, starred: e.starred, tagged: (e.tags ?? []).length > 0 }));\n          if (d.recycle) items.push({ id: e.id, cardId: e.card_id, title: e.card.wikipedia_title, rarity: e.card.rarity, rule: d.rule, label: `${e.card.wikipedia_title} [${e.card.rarity}]` });");
// pack opened: one history event per card
p = p.replace("      log(`PACK opened (${remaining} left): ${summary.join(' | ')}`);",
  "      log(`PACK opened (${remaining} left): ${summary.join(' | ')}`);\n      for (const c of r.json.cards) cardEvent('pack', { cardId: c.id, title: c.wikipedia_title, rarity: c.rarity, wishlist: wl.has(c.id) });");
must(p !== p0 && !p.includes('shouldRecycle') && p.includes("cardEvent('pack'") && p.includes("cardEvent('recycled'") && p.includes('recycleDecision'), 'packs');
guard(p0, p, 'packs.js');
fs.writeFileSync('src/packs.js', p);

// ================= sell.js: protection + history events
let s = fs.readFileSync('src/sell.js', 'utf8'); const s0 = s;
s = s.replace("import { decideSell, ownedFacts } from './rules.js';", "import { decideSell, ownedFacts } from './rules.js';\nimport { cardEvent } from './history.js';");
s = s.replace("stats = {}, info = {} }) {", "stats = {}, info = {}, isProtected = () => null }) {");
s = s.replace("        const d = decideSell(S, facts, wishlist);\n        if (d.action !== 'sell') continue;", "        if (isProtected(facts)) continue; // bought by a bid rule, or matches one: never sold\n        const d = decideSell(S, facts, wishlist);\n        if (d.action !== 'sell') continue;");
s = s.replace("      log(`SOLD ${a.card?.wikipedia_title} [${a.snapshot_rarity}] for ${a.final_price}`);", "      cardEvent('sold', { cardId: a.card_id, title: a.card?.wikipedia_title, rarity: a.snapshot_rarity, price: a.final_price });\n      log(`SOLD ${a.card?.wikipedia_title} [${a.snapshot_rarity}] for ${a.final_price}`);");
s = s.replace("          stats.listed = (stats.listed ?? 0) + 1;\n", "          stats.listed = (stats.listed ?? 0) + 1;\n          cardEvent('listed', { cardId: p.e.card_id, title: p.e.card.wikipedia_title, rarity: p.rarity, price: p.price, average: p.avg, minutes });\n");
must(s !== s0 && s.includes("cardEvent('sold'") && s.includes("cardEvent('listed'") && s.includes('isProtected(facts)'), 'sell');
guard(s0, s, 'sell.js');
fs.writeFileSync('src/sell.js', s);

// ================= bot.js: won-card memory, protection function, events
let b = fs.readFileSync('src/bot.js', 'utf8'); const b0 = b;
b = b.replace("import { startSelling } from './sell.js';", "import { startSelling } from './sell.js';\nimport { cardEvent, wonCardIds } from './history.js';");
b = b.replace("import { decide, describe, plain } from './rules.js';", "import { bidRuleMatch, decide, describe, plain } from './rules.js';");
b = b.replace("const control = { paused: false };", `const control = { paused: false };

/** Cards the bot won by bidding (remembered across restarts), plus why a card must never be sold or recycled. */
const wonIds = wonCardIds();
const protectedBy = (facts) => {
  if (wonIds.has(facts.cardId)) return 'bought by a bid rule';
  const rule = bidRuleMatch(cfg, facts, wishlist);
  return rule ? \`matches bid rule "\${rule}"\` : null;
};`);
b = b.replace("          log(`WON ${title} for ${cur.final_price ?? amount}`);", "          wonIds.add(a.card_id);\n          cardEvent('won', { cardId: a.card_id, title, rarity: a.snapshot_rarity, price: cur.final_price ?? amount, rule: ruleName });\n          log(`WON ${title} for ${cur.final_price ?? amount}`);");
b = b.replace("startPacks({\n    session, cfg, log, dry: DRY, getWishlist: () => wishlist, control, stats,", "startPacks({\n    session, cfg, log, dry: DRY, getWishlist: () => wishlist, control, stats, isProtected: protectedBy,");
b = b.replace("startSelling({ session, cfg, log, dry: DRY, getWishlist: () => wishlist, control, stats, info: sellInfo });", "startSelling({ session, cfg, log, dry: DRY, getWishlist: () => wishlist, control, stats, info: sellInfo, isProtected: protectedBy });");
must(b.includes("cardEvent('won'") && b.includes('isProtected: protectedBy,') && b.includes('info: sellInfo, isProtected: protectedBy'), 'bot');
guard(b0, b, 'bot.js');
fs.writeFileSync('src/bot.js', b);

// ================= ui.js: history endpoint
let u = fs.readFileSync('src/ui.js', 'utf8'); const u0 = u;
u = u.replace("import { Session, cookieLooksRight, normalizeCookieInput } from './http.js';", "import { Session, cookieLooksRight, normalizeCookieInput } from './http.js';\nimport { readCardEvents } from './history.js';");
u = u.replace("      if (req.method === 'GET' && url.pathname === '/api/config')", "      if (req.method === 'GET' && url.pathname === '/api/cards-history') {\n        const q = url.searchParams;\n        return send(res, 200, readCardEvents({ limit: Math.min(Number(q.get('limit')) || 300, 2000), type: q.get('type') || undefined, q: q.get('q') || undefined }));\n      }\n      if (req.method === 'GET' && url.pathname === '/api/config')");
must(u !== u0 && u.includes('cards-history'), 'ui.js');
fs.writeFileSync('src/ui.js', u);

// ================= .gitignore
let g = fs.readFileSync('.gitignore', 'utf8');
if (!g.includes('cards.jsonl')) fs.writeFileSync('.gitignore', g.replace('bids.jsonl', 'bids.jsonl\ncards.jsonl'));
console.log('history + protection patched');
