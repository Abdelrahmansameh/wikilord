import { decideSell, ownedFacts } from './rules.js';
import { cardEvent } from './history.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = ([a, b]) => a + Math.random() * (b - a);
const RANK = { L: 6, UR: 5, SR: 4, R: 3, PC: 2, C: 1 };

/** My active listings, recent history and the site's concurrent-listing limit. */
export async function fetchMyListings(session) {
  const r = await session.request('GET', '/api/marketplace?page=1&limit=1&mine=1');
  if (r.status !== 200 || !Array.isArray(r.json?.selling)) throw new Error(`listings fetch failed: HTTP ${r.status}`);
  return { selling: r.json.selling, history: r.json.history ?? [], max: r.json.maxConcurrentAuctions ?? 5 };
}

/** Whole collection plus the ids of cards locked in pending trades. */
export async function fetchCollection(session) {
  const cards = [];
  let pendingTrade = new Set();
  for (let page = 0; page < 50; page++) {
    const r = await session.request('GET', `/api/my-collection?sort=rarity&page=${page}&stats=0`);
    if (r.status !== 200 || !Array.isArray(r.json?.collection)) throw new Error(`collection fetch failed: HTTP ${r.status}`);
    if (page === 0) pendingTrade = new Set(r.json.pendingTradeCardIds ?? []);
    if (!r.json.collection.length) break;
    cards.push(...r.json.collection);
  }
  return { cards, pendingTrade };
}

/**
 * Sells cards by policy: lists the ones with the highest expected price, at a configurable share
 * (default 75%) of the average sale price the site shows, up to the site's listing limit.
 * Anything that changes the account only runs when `dry` is false.
 */
export function startSelling({ session, cfg, log, dry, getWishlist, control = { paused: false }, stats = {}, info = {}, isProtected = () => null }) {
  const S = cfg.sell;
  const cache = new Map(); // card id -> { at, summary }
  const counted = new Set(); // sold auctions already added to the revenue total
  const startedAt = Date.now();
  let busy = false;

  /** Average sale price of this card at this rarity (cached for 30 min). */
  async function average(cardId, rarity) {
    let hit = cache.get(cardId);
    let fetched = false;
    if (!hit || Date.now() - hit.at > 30 * 60_000) {
      await control.quiet?.();
      const r = await session.request('GET', `/api/marketplace/cards/${cardId}/sales?scope=summary`);
      if (r.status !== 200 || !r.json?.summary) return { error: `HTTP ${r.status}`, fetched: true };
      hit = { at: Date.now(), summary: r.json.summary };
      cache.set(cardId, hit);
      fetched = true;
    }
    return { average: hit.summary[rarity]?.average ?? null, fetched };
  }

  function trackSales(history) {
    for (const a of history) {
      if (a.status !== 'settled_sold' || a.seller_id !== cfg.myUserId || counted.has(a.id)) continue;
      if (Date.parse(a.settled_at ?? a.end_at) < startedAt) continue;
      counted.add(a.id);
      stats.soldCount = (stats.soldCount ?? 0) + 1;
      stats.soldRevenue = (stats.soldRevenue ?? 0) + (a.final_price ?? 0);
      cardEvent('sold', { cardId: a.card_id, title: a.card?.wikipedia_title, rarity: a.snapshot_rarity, price: a.final_price });
      log(`SOLD ${a.card?.wikipedia_title} [${a.snapshot_rarity}] for ${a.final_price}`);
    }
  }

  async function cycle() {
    if (busy || control.paused || !S.enabled) return;
    busy = true;
    try {
      const mine = await fetchMyListings(session);
      trackSales(mine.history);
      const cap = Math.min(S.maxListings ?? mine.max, mine.max);
      const free = cap - mine.selling.length;
      info.active = mine.selling.length;
      info.max = cap;
      info.lastRunAt = Date.now();
      if (free <= 0) return void ((info.preview = []), log(`sell: all ${cap} listing slots are in use`));

      const listed = new Set(mine.selling.map((a) => a.card_id));
      const { cards, pendingTrade } = await fetchCollection(session);
      const wishlist = getWishlist();

      // 1. which cards does the policy want to sell?
      const cands = [];
      const seenCards = new Set();
      for (const e of cards) {
        if (pendingTrade.has(e.id) || pendingTrade.has(e.card_id) || listed.has(e.card_id) || seenCards.has(e.card_id)) continue;
        const facts = ownedFacts({ card: e.card, cardId: e.card_id, shiny: e.is_shiny, starred: e.starred, tagged: (e.tags ?? []).length > 0 });
        if (isProtected(facts)) continue; // bought by a bid rule, or matches one: never sold
        const d = decideSell(S, facts, wishlist);
        if (d.action !== 'sell') continue;
        seenCards.add(e.card_id);
        cands.push({ e, rule: d.ruleObj ?? {}, ruleName: d.rule, rarity: e.card.rarity, pageviews: e.card.pageviews ?? 0 });
      }
      if (!cands.length) return void ((info.preview = []), log(`sell: ${free} free slot(s), but none of your ${cards.length} cards matches a sell rule`));

      // 2. price them (most promising first, bounded number of lookups per run)
      cands.sort((x, y) => (RANK[y.rarity] ?? 0) - (RANK[x.rarity] ?? 0) || y.pageviews - x.pageviews);
      let lookups = 0;
      const priced = [];
      for (const c of cands) {
        if (lookups >= S.lookupsPerRun && !cache.has(c.e.card_id)) continue;
        const a = await average(c.e.card_id, c.rarity);
        if (a.fetched) {
          lookups++;
          await sleep(rnd(S.lookupGapMs));
        }
        if (a.error) continue;
        const factor = c.rule.priceFactor ?? S.priceFactor;
        let price;
        if (a.average == null) {
          const fallback = c.rule.noDataPrice ?? S.noDataPrice;
          if (fallback == null) continue; // no sales history for this rarity: not worth guessing
          price = fallback;
        } else price = Math.round(a.average * factor);
        if (price < S.minListPrice) continue;
        priced.push({ ...c, avg: a.average, price, factor });
      }
      priced.sort((x, y) => y.price - x.price);
      info.preview = priced.slice(0, 8).map((p) => ({ title: p.e.card.wikipedia_title, rarity: p.rarity, avg: p.avg, price: p.price }));
      const chosen = priced.slice(0, free);
      log(`sell: ${free} free slot(s), ${cands.length} card(s) match a sell rule, ${priced.length} priced above the minimum`);
      if (!chosen.length) return;

      // 3. list the highest-priced ones
      if (dry) {
        log(`sell [dry-run] ${free} free slot(s); would list: ${chosen.map((p) => `${p.e.card.wikipedia_title} [${p.rarity}] for ${p.price}`).join(' | ')}`);
        return;
      }
      let slots = free;
      for (const p of chosen) {
        await sleep(rnd(S.gapMs));
        await control.quiet?.();
        const minutes = p.rule.durationMinutes ?? S.durationMinutes;
        const r = await session.request('POST', '/api/marketplace', { json: { card_id: p.e.id, base_amount: p.price, duration_minutes: minutes } });
        if (r.status === 201 && r.json?.auction_id) {
          slots--;
          stats.listed = (stats.listed ?? 0) + 1;
          cardEvent('listed', { cardId: p.e.card_id, title: p.e.card.wikipedia_title, rarity: p.rarity, price: p.price, average: p.avg, minutes });
          log(`LISTED ${p.e.card.wikipedia_title} [${p.rarity}] for ${p.price} (${p.avg != null ? `avg ${p.avg} x ${p.factor}` : 'no sales history'}, ${minutes} min, rule ${p.ruleName}, ${slots} slot(s) left)`);
        } else {
          log(`sell FAILED for ${p.e.card.wikipedia_title}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
          break;
        }
      }
    } catch (e) {
      log('sell error:', e.message);
    } finally {
      busy = false;
    }
  }

  // Random schedule so requests are never on a fixed beat; settings are read live.
  const next = () => setTimeout(async () => (await cycle(), next()), S.checkMinutes * 60_000 * (0.8 + Math.random() * 0.4));
  next();
  setTimeout(cycle, 30_000);
  log(`selling: ${S.enabled ? (dry ? 'on (dry-run only)' : 'ON') : 'off'}, list at ${Math.round(S.priceFactor * 100)}% of the average sale price, ${S.rules.length} sell rule(s), default=${S.default}`);
}
