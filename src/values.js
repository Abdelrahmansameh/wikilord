import fs from 'node:fs';
import { cardEvent } from './history.js';

const FILE = new URL('../values.json', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rough market value of the cards you own: the site's average sale price for each card at its rarity.
 * A slow background job looks up one card at a time and keeps the results in values.json, so the
 * numbers are approximate and can be hours old, which is fine for an overview.
 */
export function startValues({ session, log, control = {}, isProtected = () => null, staleHours = 12, cfg }) {
  const listedNow = new Map(); // card id -> time its listing ends (put on sale from the Value tab)
  let store = {};
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  let owned = []; // [{ cardId, title, rarity, shiny, count, pageviews, category }]
  let ownedAt = 0;
  let rushing = false; // set by "Refresh all prices" (re-checks everything at the normal pace)
  const save = () => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(store));
    } catch {}
  };

  async function refreshOwned() {
    const cards = [];
    for (let page = 0; page < 50; page++) {
      await control.quiet?.();
      const r = await session.request('GET', `/api/my-collection?sort=rarity&page=${page}&stats=0`);
      if (r.status !== 200 || !Array.isArray(r.json?.collection)) throw new Error(`collection HTTP ${r.status}`);
      if (!r.json.collection.length) break;
      cards.push(...r.json.collection);
    }
    owned = cards.map((e) => ({
      cardId: e.card_id, userCardId: e.id, title: e.card?.wikipedia_title, rarity: e.card?.rarity, shiny: e.is_shiny, count: e.count ?? 1,
      pageviews: e.card?.pageviews, category: e.card?.category, starred: e.starred, tagged: (e.tags ?? []).length > 0,
      card: e.card,
    }));
    ownedAt = Date.now();
  }

  async function lookup(c) {
    await control.quiet?.();
    const r = await session.request('GET', `/api/marketplace/cards/${c.cardId}/sales?scope=summary`);
    if (r.status !== 200 || !r.json?.summary) return false;
    store[c.cardId] = { at: Date.now(), summary: r.json.summary };
    return true;
  }

  async function loop() {
    for (;;) {
      try {
        if (control.paused) {
          await sleep(30_000);
          continue;
        }
        if (Date.now() - ownedAt > 30 * 60_000) await refreshOwned();
        const stale = Date.now() - staleHours * 3600_000;
        const next = owned.find((c) => !store[c.cardId] || store[c.cardId].at < stale);
        if (!next) {
          if (rushing) log('values: all prices refreshed');
          rushing = false;
          await sleep(5 * 60_000);
          continue;
        }
        await lookup(next);
        save();
        // quick first pass (a few seconds per card), then a slow pace for refreshes
        // quick only for cards never priced; refreshes (including "Refresh all prices") go at the normal slow pace
        const firstPass = owned.some((c) => !store[c.cardId]);
        await sleep(firstPass ? 3000 + Math.random() * 2000 : 20_000 + Math.random() * 10_000);
      } catch (e) {
        log('values:', e.message);
        await sleep(60_000);
      }
    }
  }
  setTimeout(loop, 45_000);

  const factsOf = (c) => ({ cardId: c.cardId, rarity: c.rarity, shiny: Boolean(c.shiny), starred: Boolean(c.starred), tagged: c.tagged,
    pageviews: c.pageviews ?? 0, qScore: Number(c.card?.q_score ?? 0), atk: c.card?.atk ?? 0, def: c.card?.def ?? 0,
    title: c.title ?? '', category: c.category ?? '', price: 0 });

  /** Owned cards with their average sale price (at their own rarity), most valuable first. */
  function getValues() {
    const rows = owned.map((c) => {
      const v = store[c.cardId];
      const average = v?.summary?.[c.rarity]?.average ?? null;
      const facts = { cardId: c.cardId, rarity: c.rarity, shiny: Boolean(c.shiny), starred: Boolean(c.starred), tagged: c.tagged,
        pageviews: c.pageviews ?? 0, qScore: Number(c.card?.q_score ?? 0), atk: c.card?.atk ?? 0, def: c.card?.def ?? 0,
        title: c.title ?? '', category: c.category ?? '', price: 0 };
      const price = average != null ? Math.max(1, Math.round(average * (cfg?.sell?.priceFactor ?? 0.75))) : null;
      return { cardId: c.cardId, title: c.title, rarity: c.rarity, shiny: c.shiny, count: c.count, average, price, checkedAt: v?.at || null, protectedBy: isProtected(facts), listed: (listedNow.get(c.cardId) ?? 0) > Date.now() };
    });
    rows.sort((a, b) => (b.average ?? -1) - (a.average ?? -1));
    const priced = rows.filter((r) => r.average != null);
    return {
      cards: rows,
      owned: rows.length,
      priced: priced.length,
      pending: rows.filter((r) => r.checkedAt == null).length,
      noHistory: rows.filter((r) => r.checkedAt != null && r.average == null).length,
      totalValue: priced.reduce((s, r) => s + r.average * (r.count ?? 1), 0),
      ownedAt,
    };
  }

  /**
   * Put one owned card on sale, only when asked from the dashboard. Uses the sell settings (price share and
   * listing length). Refuses protected cards, cards without a price, and when all listing slots are used.
   */
  async function sell(cardId, { factor, force = false } = {}) {
    const c = owned.find((x) => x.cardId === cardId);
    if (!c) return { ok: false, error: 'card not found in your collection (it may have been recycled or sold)' };
    // protected cards are only sold when you explicitly ask for that card (force), never automatically
    const why = isProtected(factsOf(c));
    if (why && !force) return { ok: false, error: `this card is protected (${why})` };
    const average = store[c.cardId]?.summary?.[c.rarity]?.average;
    if (average == null) return { ok: false, error: 'no sales history for this card yet, so there is no price to use' };
    const share = Number.isFinite(factor) && factor > 0 && factor <= 2 ? factor : cfg?.sell?.priceFactor ?? 0.75;
    const price = Math.max(1, Math.round(average * share));
    const minutes = cfg?.sell?.durationMinutes ?? 60;
    const mine = await session.request('GET', '/api/marketplace?page=1&limit=1&mine=1');
    const selling = mine.json?.selling ?? [];
    const max = mine.json?.maxConcurrentAuctions ?? 5;
    if (selling.some((a) => a.card_id === c.cardId)) return { ok: false, error: 'this card is already on sale' };
    if (selling.length >= max) return { ok: false, error: `all ${max} listing slots are in use` };
    const r = await session.request('POST', '/api/marketplace', { json: { card_id: c.userCardId, base_amount: price, duration_minutes: minutes } });
    if (r.status !== 201 || !r.json?.auction_id) return { ok: false, error: `the site refused (HTTP ${r.status}): ${r.json?.error ?? r.text.slice(0, 120)}` };
    listedNow.set(c.cardId, Date.now() + (minutes + 3) * 60_000); // after that it shows as sellable again (e.g. unsold)
    cardEvent('listed', { cardId: c.cardId, title: c.title, rarity: c.rarity, price, average, minutes, rule: force && why ? `manual, protection overridden (${why})` : 'manual (Value tab)' });
    log(`LISTED ${c.title} [${c.rarity}] for ${price} (avg ${average}, ${minutes} min) from the Value tab`);
    return { ok: true, price, minutes, slotsLeft: max - selling.length - 1 };
  }

  /** Mark every price as out of date so the job re-checks all cards at the quick pace. */
  function refreshAll() {
    for (const k of Object.keys(store)) store[k].at = 0;
    rushing = true;
    ownedAt = 0; // re-read the collection too
    log(`values: refreshing all prices (${owned.length} cards, about 25 s each)`);
    return { ok: true, cards: owned.length };
  }

  /** Average sale price of one card at a rarity: saved value if under staleHours old, otherwise one lookup. */
  async function averageOf(cardId, rarity) {
    const hit = store[cardId];
    if (!hit || !hit.at || Date.now() - hit.at > staleHours * 3600_000) {
      const ok = await lookup({ cardId }).catch(() => false);
      if (ok) save();
      else if (!hit) return null;
    }
    return store[cardId]?.summary?.[rarity]?.average ?? null;
  }

  return { getValues, sell, refreshAll, averageOf };
}
