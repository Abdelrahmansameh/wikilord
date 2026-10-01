/**
 * Finding cards for a theme. Every French Wikipedia article is a card (about 2.8 million), so:
 *   1. French Wikipedia says what belongs to a theme (categories, list articles, search),
 *   2. the game's card catalog turns those titles into cards (id, rarity, pageviews),
 *   3. the marketplace says what is on sale now and what cards usually sell for.
 * All read-only.
 */
import { plain } from './rules.js';

const WIKI = 'https://fr.wikipedia.org/w/api.php';
const WIKI_UA = 'wikimasters-bot/0.1 (personal card-collection helper; low volume)';
const CARD_FIELDS = 'id,wikipedia_title,rarity,pageviews,category,q_score,atk,def';
export const RARITY_RANK = { C: 1, PC: 2, R: 3, SR: 4, UR: 5, L: 6 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer after ${ms / 1000}s`)), ms))]);

/* ---------------- French Wikipedia ---------------- */

/** One Wikipedia API call, spaced out and retried politely when Wikipedia says "too many requests" or is lagging. */
let lastWikiAt = 0;
async function wiki(params) {
  const u = new URL(WIKI);
  for (const [k, v] of Object.entries({ action: 'query', format: 'json', formatversion: '2', maxlag: '5', ...params })) u.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const wait = lastWikiAt + 1000 - Date.now(); // at most about one request per second
    if (wait > 0) await sleep(wait);
    lastWikiAt = Date.now();
    const res = await withTimeout(fetch(u, { headers: { 'user-agent': WIKI_UA, 'api-user-agent': WIKI_UA } }), 30_000, 'Wikipedia');
    const j = res.ok ? await res.json() : null;
    const busy = res.status === 429 || res.status >= 500 || j?.error?.code === 'maxlag';
    if (busy && attempt < 5) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 5000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
    if (j.error) throw new Error(`Wikipedia: ${j.error.info ?? j.error.code}`);
    return j;
  }
}

/** Follow "continue" until done or `limit` pages collected. Redirects are resolved to the real article. */
async function generatorPages(params, limit) {
  const pages = [];
  let cont = {};
  for (let i = 0; i < 40 && pages.length < limit; i++) {
    const j = await wiki({ redirects: 1, ...params, ...cont });
    pages.push(...(j.query?.pages ?? []).filter((p) => !p.missing));
    if (!j.continue) break;
    cont = j.continue;
    await sleep(200);
  }
  return pages.slice(0, limit);
}

const catName = (name) => (/^(catégorie|category):/i.test(name) ? name.replace(/^category:/i, 'Catégorie:') : `Catégorie:${name}`);

/** Articles in a Wikipedia category, optionally with its sub-categories (`depth` levels down). */
export async function wikiCategory(name, { depth = 0, limit = 1000 } = {}) {
  const titles = new Set();
  const visited = new Set();
  let level = [catName(name)];
  for (let d = 0; d <= depth && level.length && titles.size < limit; d++) {
    const next = [];
    for (const cat of level) {
      if (visited.has(cat)) continue;
      visited.add(cat);
      const pages = await generatorPages({ generator: 'categorymembers', gcmtitle: cat, gcmtype: d < depth ? 'page|subcat' : 'page', gcmlimit: 'max' }, limit);
      for (const p of pages) {
        if (p.ns === 0) titles.add(p.title);
        else if (p.ns === 14) next.push(p.title);
      }
      if (titles.size >= limit) break;
    }
    level = next;
  }
  return { titles: [...titles].slice(0, limit), categories: [...visited] };
}

/** Articles linked from an article (list articles like "Liste de jeux Nintendo 64" are great for this). */
export async function wikiLinks(title, { limit = 1000 } = {}) {
  const pages = await generatorPages({ generator: 'links', titles: title, gplnamespace: 0, gpllimit: 'max' }, limit);
  return { titles: pages.map((p) => p.title) };
}

/** Wikipedia full-text search, best matches first. */
export async function wikiSearch(q, { limit = 50 } = {}) {
  const j = await wiki({ list: 'search', srsearch: q, srnamespace: 0, srlimit: Math.min(limit, 500) });
  return { titles: (j.query?.search ?? []).map((s) => s.title) };
}

/** Category names matching some text (category names are hard to guess: look them up first). */
export async function wikiFindCategories(q, { limit = 30 } = {}) {
  const j = await wiki({ list: 'search', srsearch: q, srnamespace: 14, srlimit: Math.min(limit, 100) });
  return { categories: (j.query?.search ?? []).map((s) => s.title) };
}

/** Sub-categories of a category, to explore a theme before picking where to look. */
export async function wikiSubcategories(name, { limit = 200 } = {}) {
  const pages = await generatorPages({ generator: 'categorymembers', gcmtitle: catName(name), gcmtype: 'subcat', gcmlimit: 'max' }, limit);
  return { categories: pages.map((p) => p.title) };
}

/* ---------------- the game's card catalog ---------------- */

const card = (c) => ({ cardId: c.id, title: c.wikipedia_title, rarity: c.rarity, pageviews: c.pageviews ?? 0, category: c.category ?? '' });

/** Exact title -> card. Titles the game does not have are listed in `missing`. */
export async function cardsByTitles(session, titles) {
  const want = [...new Set(titles.filter(Boolean))];
  const found = [];
  const quote = (t) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  for (let i = 0; i < want.length; i += 30) {
    const batch = want.slice(i, i + 30);
    const r = await withTimeout(
      session.supabase('GET', `cards?select=${CARD_FIELDS}&wikipedia_title=in.(${encodeURIComponent(batch.map(quote).join(','))})`),
      30_000,
      'card catalog',
    );
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`card catalog HTTP ${r.status}: ${r.text?.slice(0, 160)}`);
    found.push(...r.json.map(card));
    if (i + 30 < want.length) await sleep(400);
  }
  const have = new Set(found.map((c) => c.title));
  return { cards: found, missing: want.filter((t) => !have.has(t)) };
}

/** Card id -> card. */
export async function cardsByIds(session, ids) {
  const found = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await withTimeout(session.supabase('GET', `cards?select=${CARD_FIELDS}&id=in.(${ids.slice(i, i + 50).join(',')})`), 30_000, 'card catalog');
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`card catalog HTTP ${r.status}: ${r.text?.slice(0, 160)}`);
    found.push(...r.json.map(card));
  }
  return found;
}

/**
 * Search the catalog itself: `text` in the title or the short description, `category` in the short description
 * (e.g. "jeu vidéo de 1997"), plus rarity / pageview filters. Most-viewed first. Needs `text` or `category`:
 * an unfiltered query over 2.8 million cards is too heavy for the site.
 */
export async function catalogSearch(session, { text, category, rarity, minPageviews, limit = 50 } = {}) {
  if (!text && !category) throw new Error('catalog search needs some text or a category');
  const q = [`select=${CARD_FIELDS}`];
  if (text) q.push(`search_document=ilike.${encodeURIComponent(`*${plain(text)}*`)}`);
  if (category) q.push(`category=ilike.${encodeURIComponent(`*${category}*`)}`);
  const rar = (Array.isArray(rarity) ? rarity : String(rarity ?? '').split(',')).map((r) => r.trim().toUpperCase()).filter((r) => RARITY_RANK[r]);
  if (rar.length) q.push(`rarity=in.(${rar.join(',')})`);
  if (minPageviews) q.push(`pageviews=gte.${Number(minPageviews)}`);
  q.push('order=pageviews.desc', `limit=${Math.min(Number(limit) || 50, 500)}`);
  const r = await withTimeout(session.supabase('GET', `cards?${q.join('&')}`), 45_000, 'card catalog');
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`card catalog HTTP ${r.status}: ${r.text?.slice(0, 160)}`);
  return { cards: r.json.map(card) };
}

/* ---------------- marketplace ---------------- */

/** Auctions running now for these cards (searched by title, matched on card id). */
export async function auctionsFor(session, cards, { gapMs = 700 } = {}) {
  const out = [];
  for (const c of cards) {
    const q = c.title.split('(')[0].trim() || c.title; // the site's search ignores the "(qualifier)" part
    for (let p = 1; p <= 3; p++) {
      const r = await session.request('GET', `/api/marketplace?page=${p}&limit=50&sort=ending_soon&q=${encodeURIComponent(q)}`);
      if (r.status !== 200 || !r.json?.auctions) break;
      for (const a of r.json.auctions)
        if (a.card_id === c.cardId && a.status === 'active')
          out.push({
            auctionId: a.id, cardId: a.card_id, title: a.card?.wikipedia_title, rarity: a.snapshot_rarity, shiny: Boolean(a.is_shiny),
            price: a.effective_bid ?? a.current_bid ?? a.base_amount, hasBids: a.current_bid != null, endsAt: a.end_at,
          });
      if (!r.json.hasMore) break;
    }
    await sleep(gapMs);
  }
  return out;
}

/** Average sale price of a card, per rarity it was sold at (the same figure the site shows when you sell). */
export async function salesSummary(session, cardId) {
  const r = await session.request('GET', `/api/marketplace/cards/${cardId}/sales?scope=summary`);
  if (r.status !== 200) throw new Error(`sales HTTP ${r.status}`);
  return r.json?.summary ?? {};
}

/** Most interesting first: rarer, then more viewed. */
export const byRarityThenViews = (a, b) => (RARITY_RANK[b.rarity] ?? 0) - (RARITY_RANK[a.rarity] ?? 0) || b.pageviews - a.pageviews;
