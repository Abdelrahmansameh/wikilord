// Shows what the current config.json policies would do right now. Read-only.
import { Session } from './http.js';
import { loadConfig } from './config.js';
import { auctionFacts, bidRuleMatch, decide, decideRecycle, matches, ownedFacts } from './rules.js';
import { bidOnTitles, wonCardIds } from './history.js';

const cfg = loadConfig();
const session = new Session();
const tally = (arr) => arr.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

const w = await session.request('GET', '/api/cards?page=0&sort=rarity&wishlist=1');
const wishlist = new Set(w.json.wishlistCardIds ?? []);
console.log(`wishlist: ${wishlist.size} cards\n`);

// --- auctions: next ~300 to end + everything on the wishlist search is covered by the bot itself
const auctions = [];
for (let p = 1; p <= 6; p++) {
  const r = await session.request('GET', `/api/marketplace?page=${p}&limit=50&sort=ending_soon`);
  if (!r.json?.auctions?.length) break;
  auctions.push(...r.json.auctions);
}
const bids = auctions.map((a) => ({ a, d: decide(cfg, a, cfg.myUserId, wishlist) }));
console.log(`AUCTIONS (next ${auctions.length} ending): ${bids.filter((x) => x.d.action === 'bid').length} would be bid on`);
console.log('  by rule :', tally(bids.filter((x) => x.d.action === 'bid').map((x) => x.d.rule)));
console.log('  skipped :', tally(bids.filter((x) => x.d.action === 'skip').map((x) => x.d.reason.replace(/: \d+ > max.*/, ': over max'))));
for (const r of cfg.rules.filter((x) => x.enabled === false)) console.log(`  (rule "${r.name}" is disabled)`);

// --- collection
const owned = [];
let pending = new Set();
for (let p = 0; p < 50; p++) {
  const r = await session.request('GET', `/api/my-collection?sort=rarity&page=${p}&stats=0`);
  if (!r.json?.collection?.length) break;
  if (p === 0) pending = new Set(r.json.pendingTradeCardIds ?? []);
  owned.push(...r.json.collection);
}
const won = wonCardIds();
const bidTitles = bidOnTitles();
const dec = owned.map((e) => {
  if (pending.has(e.id) || pending.has(e.card_id)) return { e, action: 'keep', rule: 'pending trade (built in)' };
  const facts = ownedFacts({ card: e.card, cardId: e.card_id, shiny: e.is_shiny, starred: e.starred, tagged: (e.tags ?? []).length > 0 });
  // same protection as the bot: cards it won, and cards matching a bid rule, are never recycled
  if (won.has(e.card_id)) return { e, action: 'keep', rule: 'protected: won by a bid rule' };
  if (bidTitles.has(e.card.wikipedia_title)) return { e, action: 'keep', rule: 'protected: the bot bid on it' };
  const br = bidRuleMatch(cfg, facts, wishlist);
  if (br) return { e, action: 'keep', rule: `protected: matches bid rule ${br}` };
  return { e, ...decideRecycle(cfg.recycle, facts, wishlist) };
});
const rec = dec.filter((x) => x.action === 'recycle');
console.log(`\nRECYCLING (${cfg.recycle.enabled ? 'ENABLED' : 'disabled'}): ${owned.length} cards owned, ${rec.length} would be recycled`);
console.log('  recycled by rule:', tally(rec.map((x) => x.rule)));
console.log('  kept by rule    :', tally(dec.filter((x) => x.action === 'keep').map((x) => x.rule)));
console.log('  examples:', rec.slice(0, 5).map((x) => `${x.e.card.wikipedia_title} [${x.e.card.rarity}]`).join(' | '));
