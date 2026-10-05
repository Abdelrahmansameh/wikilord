// Command-line control of the bot, made for a Claude agent (and handy by hand): find cards for a theme, manage
// targets and budgets, check how things are going. `npm run agent -- help` lists the commands.
//
// Reading the site (catalog, marketplace, prices) works with the saved login; changes to a running bot go through
// its local dashboard API. Target changes work even when the bot is stopped (they are written to targets.json).
import fs from 'node:fs';
import { Session } from './http.js';
import { CONFIG_PATH, loadConfig, validate } from './config.js';
import { readCardEvents } from './history.js';
import { LIMIT_KEYS, changeTargets, journal, readJournal, readLimits, readTargets, targetStatus } from './targets.js';
import {
  auctionsFor, byRarityThenViews, cardsByIds, cardsByTitles, catalogSearch, salesSummary,
  wikiCategory, wikiFindCategories, wikiLinks, wikiSearch, wikiSubcategories,
} from './discover.js';
import { idsForTitles, salesFor } from './market-db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BY = process.env.WM_ACTOR || 'agent';
const PORT = process.env.WM_PORT ? Number(process.env.WM_PORT) : (() => {
  try {
    return loadConfig().ui?.port ?? 8787;
  } catch {
    return 8787;
  }
})();

/* ---------------- arguments ---------------- */
const argv = process.argv.slice(2);
const pos = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) (flags[k] ??= []).push(true);
    else (flags[k] ??= []).push(next), i++;
  } else pos.push(a);
}
const one = (k) => flags[k]?.at(-1);
const all = (k) => (flags[k] ?? []).filter((v) => v !== true);
const num = (k, d) => (one(k) === undefined ? d : Number(one(k)));
const has = (k) => flags[k] !== undefined;

/* ---------------- output ---------------- */
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const lines = (rows) => rows.forEach((r) => console.log(JSON.stringify(r)));
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const cardLine = (c, extra = '') =>
  `${c.cardId}  ${pad(c.rarity, 2)}  ${String(c.pageviews ?? '').padStart(7)}  ${c.title}${c.category ? `  — ${c.category}` : ''}${extra}`;

/* ---------------- the site and the bot ---------------- */
let _session;
function site() {
  if (_session) return _session;
  const s = new Session();
  s.renewWhenLeftSec = -Infinity; // never renew the login here: the running bot owns it and keeps it fresh
  const auth = s.readAuth();
  if (!auth?.access_token) throw new Error('no login yet: connect the bot on the dashboard (Connect tab) first');
  if (auth.expires_at && auth.expires_at * 1000 < Date.now()) throw new Error('the saved login has expired. Start the bot (it renews the login), then try again.');
  return (_session = s);
}

async function bot(method, path, body) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { 'x-bot-ui': '1', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new Error(`the bot is not running (nothing answers on http://localhost:${PORT}). Start it with start-bot.bat.`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? (j.errors ? j.errors.join('; ') : `HTTP ${res.status}`));
  return j;
}
const botUp = () => bot('GET', '/api/ids').then(() => true, () => false);

/** Card ids or exact titles -> cards from the catalog. */
async function resolveCards(refs) {
  const ids = refs.filter((r) => UUID.test(r));
  const titles = refs.filter((r) => !UUID.test(r));
  const cards = ids.length ? await cardsByIds(site(), ids) : [];
  if (titles.length) {
    const r = await cardsByTitles(site(), titles);
    cards.push(...r.cards);
    if (r.missing.length) console.error(`not found in the game (titles must match the Wikipedia title exactly): ${r.missing.join(' | ')}`);
  }
  return cards;
}

async function applyTargetOps(ops, reason) {
  ops = ops.map((o) => ({ reason, ...o }));
  if (await botUp()) return (await bot('POST', '/api/targets', { ops, by: BY })).done;
  return changeTargets(ops, { by: BY }); // bot stopped: write the file, it is read on the next start
}

/* ---------------- commands ---------------- */
const HELP = `
npm run agent -- <command> [options]          (output is JSON or one line per card: id  rarity  pageviews  title — category)

LOOK
  status                          money, limits, spend per theme (7 days), targets on auction now, wins/losses, plans
  targets [--theme t] [--all]     the target list with status (owned / auction running / expired...)
  limits                          the hard limits (limits.json, read-only here)
  history [--type won|lost|sold|recycled|listed|pack] [--days 7] [--q text] [--limit 50]
  journal [n]                     recent changes and notes (who, what, why)

FIND CARDS (read-only)
  find  [--category "Jeu vidéo Nintendo" [--depth 1]]  [--links "Liste de jeux Nintendo 64"]  [--search "text"]
        [--titles "A|B|C"]  [--catalog "text"]  [--catalog-category "jeu vidéo de 199"]
        [--rarity SR,UR,L]  [--min-pageviews 500]  [--limit 100]  [--include-owned]  [--json]
                                  Wikipedia sources give titles, the game catalog gives the cards. Any mix, repeatable.
  wiki categories <text>          find category names (look them up before using --category)
  wiki category <name> [--depth 1] | wiki subcats <name> | wiki links <title> | wiki search <text>
  cards <title or id>...          exact lookup in the game catalog
  market <title or id>...         auctions running now for these cards
  sales <title or id>... [--days N]   REAL final prices from the market analyzer's database (sold: n, min, p25, median,
                                  p75, max, last 3; unsold listings; on sale now). Best price source, and free for the site.
  prices <title or id>...         the site's average sale price per rarity (one site request per card: use sales first)

CHANGE (each change is written to the journal; --reason is recorded)
  target add <id or title> --max N [--priority 1|2|3] [--theme name] [--reason "..."] [--expires 2026-10-15]
  target set <id> [--max N] [--priority 1|2|3] [--theme name] [--reason "..."] [--expires date|none] [--on|--off] [--counters N]
  target remove <id>... [--reason "..."]
  target import <file.json> [--reason "..."]   list of { cardId or title, maxBid, priority, theme, reason, expires }
  theme set <name> [--budget N|none] [--note "..."] [--on|--off]
  theme remove <name> [--with-targets]
  wishlist add|remove <id>...
  sell <id> [--factor 0.8]        list one card now (refuses protected cards)
  recycle <id>                    recycle one card now (refuses protected cards)
  pause | resume                  stop / restart all bidding, packs and recycling
  config get [path] | config set <path> <json value>      e.g. config set global.dailySpendCap 800
  journal add "text" [--type note|plan|run]
  restart [--why "..."]           restart the bot (after a code change) and wait until it is back
`;

async function main() {
  const [cmd, sub, ...rest] = pos;
  switch (cmd) {
    case undefined:
    case 'help':
      return out(HELP);

    case 'status': {
      const r = await bot('GET', '/api/report');
      const { targets, ...restOfReport } = r;
      return out({
        ...restOfReport,
        targets: {
          total: targets.length,
          active: targets.filter((t) => t.status === 'active').length,
          owned: targets.filter((t) => t.owned).length,
          onAuctionNow: targets.filter((t) => t.auction).map((t) => ({ cardId: t.cardId, title: t.title, rarity: t.rarity, theme: t.theme, priority: t.priority, maxBid: t.effectiveMaxBid, ...t.auction })),
        },
        journal: readJournal(8),
      });
    }

    case 'targets': {
      let list;
      if (await botUp()) list = (await bot('GET', '/api/report')).targets;
      else {
        const d = readTargets();
        list = d.targets.map((t) => ({ ...t, status: targetStatus(t, d) }));
      }
      if (one('theme')) list = list.filter((t) => t.theme === one('theme'));
      if (!has('all')) list = list.filter((t) => t.status === 'active' || t.owned);
      list.sort((a, b) => (a.theme ?? '').localeCompare(b.theme ?? '') || a.priority - b.priority || b.maxBid - a.maxBid);
      return lines(list.map((t) => ({
        cardId: t.cardId, title: t.title, rarity: t.rarity, theme: t.theme, p: t.priority, maxBid: t.maxBid, status: t.status,
        ...(t.owned ? { owned: true } : {}), ...(t.auction ? { auction: t.auction } : {}), reason: t.reason, by: t.addedBy, expires: t.expires,
      })));
    }

    case 'limits':
      return out({ limits: readLimits(), meaning: LIMIT_KEYS, note: 'Only the owner edits limits.json, by hand. The bot enforces these on every bid.' });

    case 'history': {
      const days = num('days', 7);
      const r = readCardEvents({ type: one('type'), q: one('q'), sinceMs: Date.now() - days * 86400_000, limit: num('limit', 50) });
      return lines(r.events.map(({ at, type, title, rarity, price, myBid, average, rule, theme, cardId }) => ({ at, type, title, rarity, price, myBid, average, rule, theme, cardId })));
    }

    case 'journal':
      if (sub === 'add') {
        const text = rest.join(' ');
        if (!text) throw new Error('journal add "what you want to remember"');
        journal({ by: BY, type: one('type') ?? 'note', text });
        return out('noted');
      }
      return lines(readJournal(Number(sub) || 30));

    case 'wiki': {
      const arg = rest.join(' ');
      if (!arg) throw new Error('wiki category|subcats|links|search <name>');
      const r =
        sub === 'category' ? await wikiCategory(arg, { depth: num('depth', 0), limit: num('limit', 1000) })
        : sub === 'categories' ? await wikiFindCategories(arg, { limit: num('limit', 30) })
        : sub === 'subcats' ? await wikiSubcategories(arg)
        : sub === 'links' ? await wikiLinks(arg, { limit: num('limit', 1000) })
        : sub === 'search' ? await wikiSearch(arg, { limit: num('limit', 50) })
        : null;
      if (!r) throw new Error('wiki categories|category|subcats|links|search <name>');
      return out(r);
    }

    case 'cards': {
      const refs = [sub, ...rest].filter(Boolean);
      if (!refs.length) throw new Error('cards <title or id>...');
      return (await resolveCards(refs)).sort(byRarityThenViews).forEach((c) => console.log(cardLine(c)));
    }

    case 'find': {
      const sources = new Map(); // title -> Set(source)
      const add = (titles, label) => titles.forEach((t) => (sources.get(t) ?? sources.set(t, new Set()).get(t)).add(label));
      const per = num('per-source', 1000);
      for (const c of all('category')) add((await wikiCategory(c, { depth: num('depth', 0), limit: per })).titles, `cat:${c}`);
      for (const l of all('links')) add((await wikiLinks(l, { limit: per })).titles, `links:${l}`);
      for (const q of all('search')) add((await wikiSearch(q, { limit: Math.min(per, 200) })).titles, `search:${q}`);
      for (const t of all('titles')) add(t.split('|').map((x) => x.trim()).filter(Boolean), 'titles');
      const cards = new Map();
      let missing = [];
      if (sources.size) {
        const r = await cardsByTitles(site(), [...sources.keys()]);
        missing = r.missing;
        for (const c of r.cards) cards.set(c.cardId, { ...c, from: [...sources.get(c.title)] });
      }
      const fromCatalog = async (opts, label) => {
        for (const c of (await catalogSearch(site(), { ...opts, rarity: one('rarity'), minPageviews: one('min-pageviews'), limit: Math.min(per, 500) })).cards) {
          const e = cards.get(c.cardId) ?? { ...c, from: [] };
          e.from.push(label);
          cards.set(c.cardId, e);
        }
      };
      for (const text of all('catalog')) await fromCatalog({ text }, `catalog:${text}`);
      for (const category of all('catalog-category')) await fromCatalog({ category }, `catalog-category:${category}`);
      if (!['category', 'links', 'search', 'titles', 'catalog', 'catalog-category'].some((k) => all(k).length)) throw new Error('find needs at least one source: --category, --links, --search, --titles, --catalog or --catalog-category');

      const rar = one('rarity') ? String(one('rarity')).toUpperCase().split(',') : null;
      let list = [...cards.values()].filter((c) => (!rar || rar.includes(c.rarity)) && c.pageviews >= num('min-pageviews', 0));
      const ids = (await botUp()) ? await bot('GET', '/api/ids') : null;
      const owned = new Set(ids?.owned ?? []);
      const wl = new Set(ids?.wishlist ?? []);
      const tg = new Set(ids?.targets ?? readTargets().targets.map((t) => t.cardId));
      const before = list.length;
      if (!has('include-owned')) list = list.filter((c) => !owned.has(c.cardId));
      list.sort(byRarityThenViews);
      const shown = list.slice(0, num('limit', 100));
      const summary = {
        wikipediaTitles: sources.size, notInGame: missing.length, cards: cards.size, afterFilters: before,
        ownedHidden: before - list.length, shown: shown.length, ownedKnown: ids ? ids.ownedKnown : 'bot not running: owned cards not hidden',
      };
      if (has('json')) return out({ summary, cards: shown.map((c) => ({ ...c, target: tg.has(c.cardId), wishlist: wl.has(c.cardId), owned: owned.has(c.cardId) })) });
      console.log(JSON.stringify(summary));
      for (const c of shown)
        console.log(cardLine(c, `${tg.has(c.cardId) ? '  [TARGET]' : ''}${wl.has(c.cardId) ? '  [wishlist]' : ''}${owned.has(c.cardId) ? '  [owned]' : ''}  <${c.from.join(', ')}>`));
      return;
    }

    case 'market': {
      const cards = await resolveCards([sub, ...rest].filter(Boolean));
      if (!cards.length) throw new Error('market <title or id>...');
      if (cards.length > 40) throw new Error('at most 40 cards at a time (each is a marketplace search)');
      const auctions = await auctionsFor(site(), cards);
      const found = new Set(auctions.map((a) => a.cardId));
      lines(auctions.sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt)));
      const none = cards.filter((c) => !found.has(c.cardId));
      if (none.length) console.log(JSON.stringify({ noAuctionNow: none.map((c) => c.title) }));
      return;
    }

    case 'sales': {
      const refs = [sub, ...rest].filter(Boolean);
      if (!refs.length) throw new Error('sales <title or id>...');
      const titles = refs.filter((r) => !UUID.test(r));
      const known = titles.length ? await idsForTitles(titles) : new Map();
      const unknown = titles.filter((t) => !known.has(t));
      const ids = [...refs.filter((r) => UUID.test(r)), ...[...known.values()].map((c) => c.id)];
      if (unknown.length) ids.push(...(await resolveCards(unknown)).map((c) => c.cardId)); // not in the analyzer yet: ask the site
      for (const r of await salesFor(ids, { days: one('days') ? num('days') : undefined })) console.log(JSON.stringify(r));
      return;
    }

    case 'prices': {
      const cards = await resolveCards([sub, ...rest].filter(Boolean));
      if (!cards.length) throw new Error('prices <title or id>...');
      for (const c of cards.slice(0, 40)) {
        const summary = await salesSummary(site(), c.cardId).catch((e) => ({ error: e.message }));
        console.log(JSON.stringify({ cardId: c.cardId, title: c.title, rarity: c.rarity, averageAtItsRarity: summary?.[c.rarity]?.average ?? null, byRarity: summary }));
        await new Promise((r) => setTimeout(r, 600));
      }
      return;
    }

    case 'target': {
      const reason = one('reason');
      if (sub === 'add') {
        const ref = rest.join(' ');
        if (!ref || one('max') === undefined) throw new Error('target add <id or exact title> --max N [--priority 1|2|3] [--theme name] [--reason "..."]');
        const [c] = await resolveCards([ref]);
        if (!c) throw new Error(`card not found: ${ref}`);
        const op = { op: 'add', cardId: c.cardId, title: c.title, rarity: c.rarity, maxBid: num('max'), priority: num('priority', 2), theme: one('theme') ?? null, reason };
        if (one('expires')) op.expires = one('expires');
        return lines(await applyTargetOps([op], reason));
      }
      if (sub === 'set') {
        const id = rest[0];
        if (!UUID.test(id ?? '')) throw new Error('target set <card id> [--max N] [--priority 1|2|3] ...');
        const op = { op: 'update', cardId: id };
        if (one('max') !== undefined) op.maxBid = num('max');
        if (one('priority') !== undefined) op.priority = num('priority');
        if (one('theme') !== undefined) op.theme = one('theme');
        if (reason !== undefined) op.reason = reason;
        if (one('expires') !== undefined) op.expires = one('expires') === 'none' ? '' : one('expires');
        if (has('on')) op.enabled = true;
        if (has('off')) op.enabled = false;
        if (one('counters') !== undefined) op.counters = num('counters');
        return lines(await applyTargetOps([op], reason));
      }
      if (sub === 'remove') {
        if (!rest.length) throw new Error('target remove <card id>...');
        return lines(await applyTargetOps(rest.map((cardId) => ({ op: 'remove', cardId })), reason));
      }
      if (sub === 'import') {
        const list = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
        if (!Array.isArray(list)) throw new Error('the file must hold a JSON list');
        const needTitles = list.filter((x) => !UUID.test(x.cardId ?? '')).map((x) => x.title);
        const byTitle = new Map(needTitles.length ? (await cardsByTitles(site(), needTitles)).cards.map((c) => [c.title, c]) : []);
        const known = list.filter((x) => UUID.test(x.cardId ?? ''));
        const meta = new Map(known.length ? (await cardsByIds(site(), known.map((x) => x.cardId))).map((c) => [c.cardId, c]) : []);
        const ops = [];
        for (const x of list) {
          const c = UUID.test(x.cardId ?? '') ? meta.get(x.cardId) : byTitle.get(x.title);
          if (!c) {
            console.error(`skipped, not found in the game: ${x.title ?? x.cardId}`);
            continue;
          }
          ops.push({ op: 'add', cardId: c.cardId, title: c.title, rarity: c.rarity, maxBid: Number(x.maxBid), priority: Number(x.priority ?? 2), theme: x.theme ?? null, reason: x.reason ?? reason, ...(x.expires ? { expires: x.expires } : {}) });
        }
        if (!ops.length) throw new Error('nothing to import');
        return lines(await applyTargetOps(ops, reason));
      }
      throw new Error('target add|set|remove|import');
    }

    case 'theme': {
      const name = rest[0];
      if (!name) throw new Error('theme set|remove <name>');
      if (sub === 'set') {
        const op = { op: 'theme', name };
        if (one('budget') !== undefined) op.weeklyBudget = one('budget') === 'none' ? null : num('budget');
        if (one('note') !== undefined) op.note = one('note');
        if (has('on')) op.enabled = true;
        if (has('off')) op.enabled = false;
        return lines(await applyTargetOps([op], one('reason')));
      }
      if (sub === 'remove') return lines(await applyTargetOps([{ op: 'removeTheme', name, withTargets: has('with-targets') }], one('reason')));
      throw new Error('theme set|remove <name>');
    }

    case 'wishlist': {
      if (!['add', 'remove'].includes(sub) || !rest.length) throw new Error('wishlist add|remove <id>...');
      const cards = await resolveCards(rest);
      for (const c of cards) {
        const r = await bot('POST', '/api/wishlist', { cardId: c.cardId, on: sub === 'add', title: c.title });
        journal({ by: BY, type: 'action', text: `wishlist ${sub} ${c.title}`, reason: one('reason') });
        console.log(JSON.stringify({ title: c.title, ...r }));
      }
      return;
    }

    case 'sell': {
      if (!UUID.test(sub ?? '')) throw new Error('sell <card id> [--factor 0.8]');
      const r = await bot('POST', '/api/sell', { cardId: sub, factor: one('factor') === undefined ? undefined : num('factor') });
      journal({ by: BY, type: 'action', text: `listed ${sub} for ${r.price}`, reason: one('reason') });
      return out(r);
    }

    case 'recycle': {
      if (!UUID.test(sub ?? '')) throw new Error('recycle <card id>');
      const r = await bot('POST', '/api/recycle', { cardId: sub });
      journal({ by: BY, type: 'action', text: `recycled ${sub}`, reason: one('reason') });
      return out(r);
    }

    case 'pause':
    case 'resume': {
      const r = await bot('POST', '/api/pause', { paused: cmd === 'pause' });
      journal({ by: BY, type: 'action', text: cmd === 'pause' ? 'paused the bot' : 'resumed the bot', reason: one('reason') });
      return out(r);
    }

    case 'config': {
      const up = await botUp();
      const cur = up ? await bot('GET', '/api/config') : { version: null, config: JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
      const path = sub === 'get' ? rest[0] : rest[0];
      if (sub === 'get') return out(path ? path.split('.').reduce((o, k) => o?.[k], cur.config) : cur.config);
      if (sub !== 'set' || !path || rest[1] === undefined) throw new Error('config get [path] | config set <path> <json value>');
      let value;
      try {
        value = JSON.parse(rest.slice(1).join(' '));
      } catch {
        value = rest.slice(1).join(' '); // plain text
      }
      const next = structuredClone(cur.config);
      const keys = path.split('.');
      const last = keys.pop();
      const parent = keys.reduce((o, k) => (o[k] ??= {}), next);
      const before = parent[last];
      parent[last] = value;
      const errors = validate(next);
      if (errors.length) throw new Error(errors.join('; '));
      if (up) await bot('PUT', '/api/config', { version: cur.version, config: next });
      else fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
      journal({ by: BY, type: 'config', text: `config ${path}: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`, reason: one('reason') });
      return out({ ok: true, path, before, after: value });
    }

    case 'restart': {
      const before = await bot('GET', '/api/state');
      await bot('POST', '/api/restart', { why: one('why') });
      journal({ by: BY, type: 'action', text: 'restarted the bot', reason: one('why') });
      const started = Date.now();
      await new Promise((r) => setTimeout(r, 12_000));
      while (Date.now() - started < 150_000) {
        try {
          const s = await bot('GET', '/api/state');
          if (s.uptimeSec < before.uptimeSec || s.uptimeSec < (Date.now() - started) / 1000) {
            const errors = s.log.filter((l) => /unhandled error|uncaught error|IGNORED|failed/i.test(l)).slice(-10);
            return out({ ok: true, back: true, uptimeSec: s.uptimeSec, connected: s.connected, mode: s.mode, recentProblems: errors });
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error('the bot did not come back within 2.5 minutes: check bot.log (the last lines show why it stopped)');
    }

    default:
      throw new Error(`unknown command "${cmd}". npm run agent -- help`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  },
);
