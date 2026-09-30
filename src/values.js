import fs from 'node:fs';

const FILE = new URL('../values.json', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rough market value of the cards you own: the site's average sale price for each card at its rarity.
 * A slow background job looks up one card at a time and keeps the results in values.json, so the
 * numbers are approximate and can be hours old, which is fine for an overview.
 */
export function startValues({ session, log, control = {}, isProtected = () => null, staleHours = 12 }) {
  let store = {};
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  let owned = []; // [{ cardId, title, rarity, shiny, count, pageviews, category }]
  let ownedAt = 0;
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
      cardId: e.card_id, title: e.card?.wikipedia_title, rarity: e.card?.rarity, shiny: e.is_shiny, count: e.count ?? 1,
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
          await sleep(5 * 60_000);
          continue;
        }
        await lookup(next);
        save();
        // quick first pass (a few seconds per card), then a slow pace for refreshes
        const firstPass = owned.some((c) => !store[c.cardId]);
        await sleep(firstPass ? 3000 + Math.random() * 2000 : 20_000 + Math.random() * 10_000);
      } catch (e) {
        log('values:', e.message);
        await sleep(60_000);
      }
    }
  }
  setTimeout(loop, 45_000);

  /** Owned cards with their average sale price (at their own rarity), most valuable first. */
  return function getValues() {
    const rows = owned.map((c) => {
      const v = store[c.cardId];
      const average = v?.summary?.[c.rarity]?.average ?? null;
      const facts = { cardId: c.cardId, rarity: c.rarity, shiny: Boolean(c.shiny), starred: Boolean(c.starred), tagged: c.tagged,
        pageviews: c.pageviews ?? 0, qScore: Number(c.card?.q_score ?? 0), atk: c.card?.atk ?? 0, def: c.card?.def ?? 0,
        title: c.title ?? '', category: c.category ?? '', price: 0 };
      return { title: c.title, rarity: c.rarity, shiny: c.shiny, count: c.count, average, checkedAt: v?.at ?? null, protectedBy: isProtected(facts) };
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
  };
}
