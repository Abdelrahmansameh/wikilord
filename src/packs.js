import { decideRecycle, ownedFacts } from './rules.js';
import { fetchMyListings } from './sell.js';
import { cardEvent } from './history.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = ([a, b]) => a + Math.random() * (b - a);

/**
 * Opens packs whenever they are available and recycles unwanted cards.
 * Everything that changes the account only runs when `dry` is false.
 */
export function startPacks({ session, cfg, log, dry, getWishlist, control = { paused: false }, stats = {}, onBalance, isProtected = () => null }) {
  const P = cfg.packs ?? { enabled: false };
  const R = cfg.recycle ?? { enabled: false };
  let pausedUntil = 0;
  let busy = false;

  /** Apply the recycle.rules policy to one owned card. */
  /** { recycle, rule, protectedBy }: cards bought by bid rules, or matching a bid rule, are never recycled. */
  const recycleDecision = (facts) => {
    const protectedBy = isProtected(facts);
    if (protectedBy) return { recycle: false, rule: null, protectedBy };
    const d = decideRecycle(R, facts, getWishlist());
    return { recycle: d.action === 'recycle', rule: d.rule, protectedBy: null };
  };

  async function discard(it) {
    const userCardId = it.id;
    const label = it.label;
    const r = await session.request('POST', `/api/user-cards/${userCardId}/discard`);
    if (r.status === 200 && typeof r.json?.balance === 'number') {
      stats.recycled = (stats.recycled ?? 0) + 1;
      const gained = onBalance?.(r.json.balance);
      cardEvent('recycled', { cardId: it.cardId, title: it.title, rarity: it.rarity, rule: it.rule, gained, balance: r.json.balance });
      log(`recycled ${label} -> balance ${r.json.balance}`);
      return true;
    }
    log(`recycle FAILED ${label}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
    return false;
  }

  async function recycleList(items, why) {
    const todo = items.slice(0, R.maxPerRun);
    if (!todo.length) return 0;
    if (dry || !R.enabled) {
      log(`recycle [${dry ? 'dry-run' : 'disabled'}] would recycle ${todo.length} card(s) (${why}): ${todo.slice(0, 8).map((x) => x.label).join(', ')}${todo.length > 8 ? ', ...' : ''}`);
      return 0;
    }
    let done = 0;
    for (const it of todo) {
      await sleep(rnd(R.gapMs));
      await control.quiet?.();
      if (!(await discard(it))) break;
      done++;
    }
    return done;
  }

  /** Recycle the unwanted commons that just came out of a pack. */
  async function recycleFromPack(pack) {
    const byId = new Map(pack.cards.map((c) => [c.id, c]));
    const items = [];
    for (const o of pack.owned_copies ?? []) {
      const c = byId.get(o.card_id);
      if (!c) continue;
      const d = recycleDecision(ownedFacts({ card: c, cardId: o.card_id, shiny: o.is_shiny, starred: o.starred, tagged: (o.user_card_tags ?? []).length > 0 }));
      if (d.recycle) items.push({ id: o.id, cardId: o.card_id, title: c.wikipedia_title, rarity: c.rarity, rule: d.rule, label: `${c.wikipedia_title} [${c.rarity}]` });
    }
    return recycleList(items, 'from pack');
  }

  /** Scan the whole collection for recyclable cards. */
  async function sweep() {
    for (let round = 1; round <= 5; round++) {
      const items = [];
      let seen = 0;
      let pendingTrade = new Set();
      // a card that is up for sale stays in the collection list: never recycle it
      let listed;
      try {
        listed = new Set((await fetchMyListings(session)).selling.map((a) => a.card_id));
      } catch (err) {
        return void log(`sweep: could not read my listings (${err.message}); skipping this run to be safe`);
      }
      for (let page = 0; page < 50; page++) {
        const r = await session.request('GET', `/api/my-collection?sort=rarity&page=${page}&stats=0`);
        if (r.status !== 200 || !Array.isArray(r.json?.collection)) return void log(`sweep: collection fetch failed HTTP ${r.status}`);
        if (page === 0) pendingTrade = new Set(r.json.pendingTradeCardIds ?? []);
        if (!r.json.collection.length) break;
        seen += r.json.collection.length;
        for (const e of r.json.collection) {
          if (pendingTrade.has(e.id) || pendingTrade.has(e.card_id) || listed.has(e.card_id)) continue;
          const d = recycleDecision(ownedFacts({ card: e.card, cardId: e.card_id, shiny: e.is_shiny, starred: e.starred, tagged: (e.tags ?? []).length > 0 }));
          if (d.recycle) items.push({ id: e.id, cardId: e.card_id, title: e.card.wikipedia_title, rarity: e.card.rarity, rule: d.rule, label: `${e.card.wikipedia_title} [${e.card.rarity}]` });
        }
        if (r.json.total != null && seen >= r.json.total) break;
      }
      if (round === 1) log(`sweep: ${seen} cards in collection, ${items.length} recyclable`);
      if (!items.length) return;
      const done = await recycleList(items, 'collection sweep');
      if (!done) return; // dry-run / disabled / failed: do not loop
    }
  }

  async function openPacks() {
    const s = await session.rpc('sync_profile_packs', { user_id: cfg.myUserId });
    const remaining0 = s.json?.packs_remaining;
    if (typeof remaining0 !== 'number') return void log(`packs: sync failed HTTP ${s.status} ${s.text.slice(0, 120)}`);
    if (remaining0 <= 0) return;
    if (dry) return void log(`packs [dry-run] ${remaining0} pack(s) available, would open them`);

    let remaining = remaining0;
    let opened = 0;
    while (remaining > 0 && opened < P.maxPerRun) {
      await sleep(rnd(P.gapMs));
      await control.quiet?.();
      const r = await session.request('POST', '/api/packs/open');
      if (r.status !== 200 || !Array.isArray(r.json?.cards)) {
        const body = r.text.slice(0, 200);
        if (/captcha|human|verif|turnstile/i.test(body)) {
          pausedUntil = Date.now() + 3600_000;
          return void log(`packs: the site asks for human verification (HTTP ${r.status}). Pausing pack opening for 1h. Open a pack in your browser once to verify. ${body}`);
        }
        pausedUntil = Date.now() + P.backoffMinutes * 60_000;
        return void log(`packs: open failed HTTP ${r.status} ${body}. Backing off ${P.backoffMinutes} min.`);
      }
      opened++;
      stats.packs = (stats.packs ?? 0) + 1;
      remaining = r.json.packs_remaining ?? remaining - 1;
      const wl = getWishlist();
      const summary = r.json.cards.map((c) => `${c.wikipedia_title} [${c.rarity}]${wl.has(c.id) ? ' *WISHLIST*' : ''}`);
      log(`PACK opened (${remaining} left): ${summary.join(' | ')}`);
      for (const c of r.json.cards) cardEvent('pack', { cardId: c.id, title: c.wikipedia_title, rarity: c.rarity, wishlist: wl.has(c.id) });
      if (R.enabled && R.afterPackOpen) await recycleFromPack(r.json);
    }
  }

  async function tick() {
    if (busy || control.paused || Date.now() < pausedUntil) return;
    busy = true;
    try {
      if (P.enabled) await openPacks();
    } catch (e) {
      log('packs error:', e.message);
    } finally {
      busy = false;
    }
  }

  async function sweepTick() {
    if (control.paused) return;
    if (busy) return void setTimeout(sweepTick, 15_000); // wait for the pack routine to finish
    busy = true;
    try {
      if (R.sweepExisting) await sweep();
    } catch (e) {
      log('sweep error:', e.message);
    } finally {
      busy = false;
    }
  }

  // Randomised schedules so requests are never on a fixed beat.
  const loop = (fn, baseSec, jitterSec) => {
    const next = () => setTimeout(async () => (await fn(), next()), (baseSec() + Math.random() * jitterSec()) * 1000);
    next();
  };
  loop(tick, () => P.checkSeconds, () => P.jitterSeconds);
  loop(sweepTick, () => R.sweepMinutes * 60, () => R.sweepMinutes * 12);
  setTimeout(sweepTick, 20_000);
  setTimeout(tick, 8_000);
  log(`packs: ${P.enabled ? 'on' : 'off'}, recycle: ${R.enabled ? (dry ? 'on (dry-run only)' : 'ON') : 'off (report only)'}, ${R.rules.length} recycle rule(s), default=${R.default}`);
}
