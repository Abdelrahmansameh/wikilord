import http from 'node:http';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { normalizeCookieInput, cookieLooksRight, SESSION_FILE, ENV_FILE, PREMIUM_SESSION_FILE, PREMIUM_ENV_FILE } from './session.js';
import { EVENTS_PATH, listPremiumArchives, readHistoryPage, readPremiumArchiveHistory,
  readSnipeHistoryPage } from './state.js';
import { saveConfigAtomic, validateConfig, patchOperationalSettings } from './config.js';
import { nextDealBid } from './deals.js';
import { createSettingsQueue } from './settings-queue.js';

const HTML = new URL('./ui.html', import.meta.url);
const PREMIUM_HTML = new URL('./premium-ui.html', import.meta.url);
const DEFAULT_DB = fileURLToPath(new URL('../../market-analyzer/market.db', import.meta.url));
const marketDbPath = (config) => process.env.WM_MARKET_DB ?? (config.marketDb
  ? fileURLToPath(new URL(config.marketDb, new URL('../', import.meta.url))) : DEFAULT_DB);
const SECURITY = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

function savedUserId(file) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    const jar = /\.env(?:\.|$)/.test(file.pathname)
      ? Object.fromEntries((source.match(/^COOKIE=(.*)$/m)?.[1] ?? '').split(';').map((part) => {
        const i = part.indexOf('=');
        return i > 0 ? [part.slice(0, i).trim(), part.slice(i + 1).trim()] : [null, null];
      }).filter(([key]) => key))
      : JSON.parse(source);
    const key = Object.keys(jar).find((k) => /^sb-[\w-]+-auth-token$/.test(k));
    const prefix = key ?? Object.keys(jar).find((k) => /^sb-[\w-]+-auth-token\.0$/.test(k))?.slice(0, -2);
    if (!prefix) return null;
    let raw = jar[prefix] ?? '';
    if (!raw) for (let i = 0; jar[`${prefix}.${i}`]; i++) raw += jar[`${prefix}.${i}`];
    if (raw.startsWith('base64-')) raw = Buffer.from(raw.slice(7), 'base64url').toString('utf8');
    return JSON.parse(decodeURIComponent(raw)).user?.id ?? null;
  } catch { return null; }
}

function otherAccountIds(account = 'standard', sessions = {}) {
  const ids = [
    new URL('../../.session.json', import.meta.url),
    new URL('../../.env', import.meta.url),
    new URL('../../market-analyzer/.session.json', import.meta.url),
    new URL('../../market-analyzer/.session.secondary.json', import.meta.url),
    new URL('../../market-analyzer/.env', import.meta.url),
    new URL('../../market-analyzer/.env.secondary', import.meta.url),
  ].map(savedUserId).filter(Boolean);
  const other = account === 'premium' ? 'standard' : 'premium';
  const paths = other === 'standard' ? [SESSION_FILE, ENV_FILE] : [PREMIUM_SESSION_FILE, PREMIUM_ENV_FILE];
  ids.push(...paths.map(savedUserId).filter(Boolean));
  const liveId = sessions[other]?.userId?.();
  if (liveId) ids.push(liveId);
  try {
    const id = JSON.parse(fs.readFileSync(new URL('../../config.json', import.meta.url), 'utf8')).myUserId;
    if (id) ids.push(id);
  } catch {}
  return new Set(ids);
}

export function accountConflicts(userId, { account = 'standard', sessions = {} } = {}) {
  return Boolean(userId && otherAccountIds(account, sessions).has(userId));
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new Error('send JSON');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw new Error('request is too large');
  }
  return body ? JSON.parse(body) : {};
}

/** Local dashboard. The phone viewer proxies it after checking the Tailscale owner. */
export function startDashboard({ engine: defaultEngine, session: defaultSession, model, config: defaultConfig,
  log = () => {}, historyFile: defaultHistoryFile = EVENTS_PATH, accounts } = {}) {
  const byAccount = accounts ?? { standard: { engine: defaultEngine, session: defaultSession,
    config: defaultConfig, historyFile: defaultHistoryFile } };
  for (const selected of Object.values(byAccount)) selected.loadedSettingsVersion = selected.configFile && fs.existsSync(selected.configFile) ? fs.statSync(selected.configFile).mtimeMs : 0;
  const port = Number(defaultConfig.ui?.port ?? defaultConfig.port ?? 8789);
  let exampleCache = { until: 0, rows: [] };
  const dealDetailModelCache = new Map();
  let settingsBusy = false;
  const premiumAccount = byAccount.premium;
  const premiumSettingsQueue = premiumAccount?.configFile && createSettingsQueue({
    file: `${typeof premiumAccount.configFile === 'string' ? premiumAccount.configFile : fileURLToPath(premiumAccount.configFile)}.pending-settings.json`,
    getConfig: () => premiumAccount.config,
    isBusy: () => settingsBusy || premiumAccount.engine.getState().busy,
    validate: (next) => validateConfig(next, { premium: true }),
    log,
    apply: async (next) => {
      settingsBusy = true;
      const previous = premiumAccount.config;
      let wroteConfig = false;
      const version = () => fs.statSync(premiumAccount.configFile).mtimeMs;
      try {
        if (premiumAccount.loadedSettingsVersion !== version())
          throw new Error('The config file was edited outside this engine. Restart before applying settings.');
        saveConfigAtomic(next, premiumAccount.configFile);
        wroteConfig = true;
        try { await premiumAccount.engine.updateConfig(next); }
        catch (error) { saveConfigAtomic(previous, premiumAccount.configFile); throw error; }
        premiumAccount.config = next;
      } finally {
        if (wroteConfig) premiumAccount.loadedSettingsVersion = version();
        settingsBusy = false;
      }
    },
  });
  const pausedRefreshAt = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, ...SECURITY });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return send(403, { error: 'forbidden host' });
    const url = new URL(req.url, `http://${host}`);
    const premiumRoute = url.pathname === '/premium' || url.pathname.startsWith('/premium/')
      || url.pathname === '/api/premium' || url.pathname.startsWith('/api/premium/');
    const account = premiumRoute ? 'premium' : 'standard';
    const selected = byAccount[account];
    if (!selected) return send(404, { error: 'account not configured' });
    const { engine, session, config } = selected;
    const historyFile = selected.historyFile ?? defaultHistoryFile;
    const apiPath = url.pathname.startsWith('/api/premium/')
      ? '/api/' + url.pathname.slice('/api/premium/'.length) : url.pathname;
    if (req.method === 'POST' && (req.headers.origin !== `http://${host}` || !String(req.headers['content-type'] ?? '').startsWith('application/json')))
      return send(403, { error: 'request must come from this dashboard' });
    try {
      if (req.method === 'GET' && premiumRoute && ['/premium', '/premium/overview', '/premium/deals', '/premium/history', '/premium/settings'].includes(url.pathname))
        return send(200, fs.readFileSync(PREMIUM_HTML), 'text/html; charset=utf-8');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/history'))
        return send(200, fs.readFileSync(HTML), 'text/html; charset=utf-8');
      if (req.method === 'GET' && apiPath === '/api/history') {
        const rawBefore = url.searchParams.get('before');
        const before = rawBefore == null ? Infinity : Number(rawBefore);
        const category = url.searchParams.get('category') ?? 'all';
        const query = (url.searchParams.get('q') ?? '').trim();
        if (rawBefore != null && (!Number.isSafeInteger(before) || before < 0))
          return send(400, { error: 'invalid history cursor' });
        if (query.length > 100) return send(400, { error: 'history search is too long' });
        if (!['all', 'packs', 'listings', 'recycling', 'alerts', 'deals'].includes(category))
          return send(400, { error: 'invalid history category' });
        const options = { before, limit: 50, category, query };
        if (account === 'premium' && url.searchParams.has('archive')) {
          try { return send(200, readPremiumArchiveHistory(url.searchParams.get('archive'), options)); }
          catch (error) { return send(404, { error: error.message }); }
        }
        return send(200, readHistoryPage(historyFile, options));
      }
      if (account === 'premium' && req.method === 'GET' && apiPath === '/api/account-archives')
        return send(200, { archives: listPremiumArchives() });
      if (req.method === 'GET' && apiPath === '/api/state') {
        const state = engine.getState();
        if (state.paused && state.connected && engine.refreshListings
            && Date.now() - (pausedRefreshAt.get(account) ?? 0) > 30_000) {
          pausedRefreshAt.set(account, Date.now());
          engine.refreshListings().catch((error) => log(`${account} paused listing refresh: ${error.message}`));
        }
        return send(200, { ...engine.getState(), account: session.username?.() ?? null,
          connected: session.hasCookie?.() ?? false, targetProbability: config.targetProbability ?? 0.8 });
      }
      if (account === 'premium' && req.method === 'GET' && apiPath === '/api/deals')
        return send(200, engine.getDeals?.() ?? engine.getState().deals ?? {});
      if (account === 'premium' && req.method === 'GET' && apiPath === '/api/snipe-history') {
        const rawBefore = url.searchParams.get('before');
        const before = rawBefore == null ? Infinity : Number(rawBefore);
        if (rawBefore != null && (!Number.isSafeInteger(before) || before < 0))
          return send(400, { error: 'invalid snipe history cursor' });
        const activePlanIds = ((engine.getDeals?.() ?? {}).plans ?? []).map((plan) => plan.auctionId);
        const page = readSnipeHistoryPage(historyFile, { before, limit: 25, activePlanIds });
        const legacyCapSkips = page.rows.filter((row) => row.latestType === 'deal-snipe-skipped'
          && row.reason?.includes('next bid exceeds cautious resale cap') && row.requiredBid == null);
        const ids = [...new Set([...page.rows.filter((row) => !row.title).map((row) => row.auctionId),
          ...legacyCapSkips.map((row) => row.auctionId)])];
        if (ids.length) {
          const db = new DatabaseSync(marketDbPath(config), { readOnly: true });
          try {
            const found = db.prepare(`SELECT id, card_id cardId, title, rarity, is_shiny shiny,
                base_amount baseAmount, end_at endAt
              FROM auctions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
            const byId = new Map(found.map((row) => [row.id, row]));
            for (const row of page.rows) {
              const auction = byId.get(row.auctionId);
              if (auction) Object.assign(row, { cardId: row.cardId ?? auction.cardId,
                title: row.title ?? auction.title, rarity: row.rarity ?? auction.rarity,
                shiny: row.shiny ?? Boolean(auction.shiny), endAt: row.endAt ?? auction.endAt });
            }
            const priorBid = db.prepare(`SELECT amount FROM bids WHERE auction_id = ?
              AND placed_at <= ? ORDER BY placed_at DESC LIMIT 1`);
            for (const row of legacyCapSkips) {
              const prior = priorBid.get(row.auctionId, row.at);
              if (!Number.isFinite(prior?.amount)) continue;
              row.recordedBid = prior.amount;
              row.reconstructedRequiredBid = nextDealBid({ current_bid: prior.amount },
                Number(config.buy?.bidIncrement ?? 1));
            }
          } finally { db.close(); }
        }
        return send(200, page);
      }
      const settingsVersion = () => selected.configFile && fs.existsSync(selected.configFile) ? fs.statSync(selected.configFile).mtimeMs : 0;
      if (req.method === 'GET' && apiPath === '/api/settings') {
        const displayed = account === 'premium' ? premiumSettingsQueue?.proposedConfig() ?? config : config;
        return send(200, { dryRun: displayed.dryRun, premium: displayed.premium, buy: displayed.buy, trades: displayed.trades,
          listingFee: config.listingFee, mode: engine.getState().mode, version: settingsVersion(), config,
          pendingSettings: account === 'premium' ? premiumSettingsQueue?.status() ?? null : null,
          sourceChanged: selected.loadedSettingsVersion !== settingsVersion() });
      }
      if (req.method === 'POST' && apiPath === '/api/settings' && (account === 'standard' || req.headers['x-jarvis-settings'] === '1')) {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Object.keys(body).some((key) => !['version', 'changes', 'preview'].includes(key)))
          return send(400, { error: 'Send version and approved operational settings changes.' });
        if (body.version !== settingsVersion()) return send(409, { error: 'Money settings changed; read the current settings again.' });
        if (selected.loadedSettingsVersion !== settingsVersion()) return send(409, { error: 'The config file was edited outside this engine. Restart the money bot before changing settings.' });
        let next;
        try { next = patchOperationalSettings(config, body.changes, { premium: account === 'premium' }); }
        catch (error) { return send(400, { error: error.message }); }
        if (body.preview === true) return send(200, { ok: true, preview: true, config: next });
        if (!selected.configFile) return send(409, { error: 'Settings file is not configured.' });
        if (account === 'premium' && premiumSettingsQueue?.pending()) return send(409, { error: 'Premium settings are queued; wait for them to apply before editing operational settings.' });
        if (engine.getState().busy || settingsBusy) return send(409, { error: 'An account is busy; retry after its cycle finishes.' });
        if (typeof engine.updateConfig !== 'function') return send(409, { error: 'This engine cannot apply settings.' });
        settingsBusy = true;
        try {
          saveConfigAtomic(next, selected.configFile, { premium: account === 'premium' });
          try { await engine.updateConfig(next); }
          catch (error) { saveConfigAtomic(config, selected.configFile, { premium: account === 'premium' }); selected.loadedSettingsVersion = settingsVersion(); return send(409, { error: `Settings were not applied: ${error.message}` }); }
          selected.config = next;
          selected.loadedSettingsVersion = settingsVersion();
          return send(200, { ok: true, version: settingsVersion(), config: next, mode: engine.getState().mode });
        } finally { settingsBusy = false; }
      }
      if (account === 'premium' && req.method === 'POST' && apiPath === '/api/settings') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some((key) => !['dryRun', 'premium', 'buy', 'trades'].includes(key)))
          return send(400, { error: 'Only dryRun, premium, buy, and trade settings can be changed here.' });
        const next = structuredClone(premiumSettingsQueue?.proposedConfig() ?? config);
        if (Object.hasOwn(body, 'dryRun')) next.dryRun = body.dryRun;
        for (const section of ['premium', 'buy', 'trades']) if (Object.hasOwn(body, section)) {
          if (!body[section] || typeof body[section] !== 'object' || Array.isArray(body[section])
              || Object.keys(body[section]).some((key) => !Object.hasOwn(next[section], key)))
            return send(400, { error: `Unknown or malformed ${section} setting.` });
          next[section] = { ...next[section], ...body[section] };
        }
        const errors = validateConfig(next, { premium: true });
        if (errors.length) return send(400, { error: errors.join('; ') });
        if (!selected.configFile) return send(409, { error: 'settings file is not configured' });
        if (selected.loadedSettingsVersion !== settingsVersion() && !premiumSettingsQueue?.applying())
          return send(409, { error: 'The config file was edited outside this engine. Restart before saving settings.' });
        if (typeof engine.updateConfig !== 'function') return send(409, { error: 'This engine cannot apply settings.' });
        const pendingSettings = premiumSettingsQueue.enqueue(next);
        return send(202, { ok: true, queued: true, pendingSettings, dryRun: next.dryRun,
          premium: next.premium, buy: next.buy, trades: next.trades, mode: engine.getState().mode });
      }
      const detailMatch = req.method === 'GET' && apiPath.match(/^\/api\/listings\/([a-zA-Z0-9-]+)\/details$/);
      if (detailMatch) {
        const listing = engine.getState().activeListings?.find((item) => item.auctionId === detailMatch[1]);
        if (!listing) return send(404, { error: 'listing is no longer active' });
        const card = { cardId: listing.cardId, title: listing.title, rarity: listing.rarity,
          shiny: listing.shiny, qScore: listing.qScore, pageviews: listing.pageviews,
          atk: listing.atk, def: listing.def, category: listing.category };
        let quote = { curve: [], evidence: {} }, modelError = null, stats = null, strategy = 'routine';
        try {
          const options = {
            recycleValue: config.recycleValue ?? 1, listingFee: config.listingFee ?? 0,
            targetProbability: config.targetProbability ?? 0.8,
            outcomePenalty: config.outcomePenalty ?? 0.25,
            modelLowerPenalty: config.modelLowerPenalty ?? 0.5,
            modelUpperBonus: config.modelUpperBonus ?? 1.28,
          };
          if (account === 'premium' && model.stats && model.quoteAtPrices) {
            stats = await model.stats(card);
            if (config.buy?.hybridEnabled && model.dealQuote
                && selected.store?.data.purchases?.[listing.userCardId]?.resalePlan) {
              strategy = 'hybrid-resale';
              quote = await model.dealQuote(card, {
                buy: config.buy, premiumThreshold: config.premium.minMedian,
                listingFee: config.listingFee, durationMinutes: config.listing.durationMinutes,
                ownOutcomes: Object.values(selected.store.data.listings ?? {}),
              });
            } else if (listing.kind === 'premium' || (stats.soldCount >= config.premium.minSold
                && stats.median > config.premium.minMedian)) {
              strategy = 'premium';
              const median = Math.max(1, Number(stats.median ?? listing.price));
              const low = Math.max(1, Math.floor(Math.min(median * 0.75, listing.price * 0.8)));
              const high = Math.max(low + 1, Math.ceil(Math.max(median * config.premium.maxAskRatio,
                listing.price * 1.2)));
              const prices = [...new Set([Math.round(listing.price), ...Array.from({ length: 31 }, (_, i) =>
                Math.max(1, Math.round(low * (high / low) ** (i / 30))) )])].sort((a, b) => a - b);
              quote = await model.quoteAtPrices(card, prices, {
                ...options, targetProbability: config.premium.minSaleProbability });
            } else quote = await model.quote(card, options);
          } else quote = await model.quote(card, options);
        } catch (error) { modelError = error.message; }
        return send(200, { listing, card, quote, stats, strategy, modelError });
      }
      const dealDetailMatch = req.method === 'GET' && account === 'premium'
        && apiPath.match(/^\/api\/deals\/([a-zA-Z0-9-]+)\/details$/);
      if (dealDetailMatch) {
        const deals = engine.getDeals?.() ?? engine.getState().deals ?? {};
        const auctionId = dealDetailMatch[1];
        let deal = [...(deals.plans ?? []), ...(deals.candidates ?? []),
          ...(deals.watchlist ?? []), ...(deals.rejections ?? [])]
          .find((item) => String(item.auctionId ?? '') === auctionId);
        const db = new DatabaseSync(marketDbPath(config), { readOnly: true });
        let auction = null;
        try {
          auction = db.prepare(`SELECT id auctionId, card_id cardId, title, rarity, is_shiny shiny,
              seller_id sellerId, base_amount baseAmount, listing_base_amount startPrice,
              current_bid currentBid, current_bidder_id currentBidderId, effective_bid effectiveBid,
              bid_count bidCount, status, final, final_price finalPrice, end_at endAt,
              q_score qScore, pageviews, atk, def, category
            FROM auctions WHERE id = ?`).get(auctionId) ?? null;
        } finally { db.close(); }
        if (!deal && !auction) return send(404, { error: 'auction is not in the recorded market data' });
        deal ??= { auctionId, ...auction,
          price: auction.currentBid ?? auction.baseAmount,
          reason: 'This deal is no longer in the current candidate list.' };
        const card = { cardId: deal.cardId ?? deal.card_id ?? auction?.cardId,
          title: deal.title ?? auction?.title, rarity: deal.rarity ?? auction?.rarity,
          shiny: Boolean(deal.shiny ?? auction?.shiny), qScore: deal.qScore ?? auction?.qScore,
          pageviews: deal.pageviews ?? auction?.pageviews, atk: deal.atk ?? auction?.atk,
          def: deal.def ?? auction?.def, category: deal.category ?? auction?.category };
        const configKey = JSON.stringify([config.buy, config.listingFee,
          selected.store?.data.stats?.sold, selected.store?.data.stats?.unsold]);
        const cachedDetail = dealDetailModelCache.get(auctionId);
        let modelTask = cachedDetail?.until > Date.now() && cachedDetail.configKey === configKey
          ? cachedDetail.task : null;
        if (!modelTask) {
          modelTask = (async () => {
            let stats = null, quote = { curve: [], evidence: {} }, modelError = null;
            try {
              if (model?.stats) stats = await model.stats(card);
              if (config.buy?.hybridEnabled && model?.dealQuote) {
                const portfolio = engine.getPortfolio?.() ?? {};
                quote = await model.dealQuote(card, {
                  buy: config.buy, premiumThreshold: config.premium.minMedian,
                  listingFee: config.listingFee, durationMinutes: config.listing.durationMinutes,
                  cutoff: portfolio.cutoff?.value ?? portfolio.cutoff,
                  queueDepth: portfolio.queueDepth, slots: portfolio.slots?.max ?? 5,
                  ownOutcomes: Object.values(selected.store?.data.listings ?? {}),
                });
                if (quote.reason) modelError = quote.reason;
              } else if (model?.quoteAtPrices) {
                const priceValues = [deal.price, deal.currentBid, deal.baseAmount, deal.amount,
                  deal.maxBid, deal.safeExit, stats?.p25, stats?.median]
                  .map(Number).filter((value) => Number.isFinite(value) && value > 0);
                const center = Math.max(1, ...priceValues);
                const floor = Math.max(1, Math.floor((priceValues.length ? Math.min(...priceValues) : 1) * 0.55));
                const ceiling = Math.max(floor + 1, Math.ceil(center * 1.35));
                const prices = [...new Set([
                  ...Array.from({ length: 31 }, (_, i) => Math.max(1,
                    Math.round(floor * (ceiling / floor) ** (i / 30)))),
                  ...priceValues.map(Math.round),
                ])].sort((a, b) => a - b);
                quote = await model.quoteAtPrices(card, prices, {
                  listingFee: config.listingFee ?? 0,
                  targetProbability: config.buy?.exitProbability ?? 0.8,
                });
              } else if (model?.quote) quote = await model.quote(card, config);
            } catch (error) { modelError = error.message; }
            return { quote, stats, modelError, modelPending: false };
          })();
          dealDetailModelCache.set(auctionId, { task: modelTask, until: Date.now() + 30_000, configKey });
          if (dealDetailModelCache.size > 100) dealDetailModelCache.delete(dealDetailModelCache.keys().next().value);
        }
        const pending = { quote: { curve: [], evidence: {} }, stats: null,
          modelError: 'Pricing model is still loading.', modelPending: true };
        let timer;
        const result = await Promise.race([modelTask, new Promise((resolve) => {
          timer = setTimeout(() => resolve(pending), 4000);
        })]);
        clearTimeout(timer);
        return send(200, { deal, auction, card, ...result });
      }
      if (req.method === 'GET' && apiPath === '/api/auctions') {
        const cardId = url.searchParams.get('cardId') ?? '';
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(cardId)) return send(400, { error: 'invalid card ID' });
        const db = new DatabaseSync(marketDbPath(config), { readOnly: true });
        let rows;
        try {
          rows = db.prepare(`SELECT id, rarity, is_shiny shiny, status, final,
              listing_base_amount startPrice, base_amount currentBase,
              final_price finalPrice, current_bid currentBid, bid_count bidCount,
              base_repriced_at repricedAt, end_at endAt
            FROM auctions WHERE card_id = ?
            ORDER BY COALESCE(settled_at, end_at, created_at) DESC, id DESC`).all(cardId);
        } finally { db.close(); }
        return send(200, { cardId, rows });
      }
      if (req.method === 'GET' && apiPath === '/api/examples') {
        if (!model) return send(200, { rows: [] });
        if (Date.now() < exampleCache.until) return send(200, { rows: exampleCache.rows });
        const dbPath = marketDbPath(config);
        const db = new DatabaseSync(dbPath, { readOnly: true });
        let cards;
        try {
          cards = ['C', 'R', 'SR', 'UR', 'L'].flatMap((rarity) => db.prepare(
            `SELECT id cardId, title, rarity, is_shiny shiny, q_score qScore, pageviews, atk, def, category
             FROM cards WHERE rarity = ? AND times_listed >= 5 ORDER BY times_sold DESC LIMIT 1`,
          ).all(rarity));
        } finally { db.close(); }
        const rows = [];
        for (const card of cards) rows.push({ card, quote: await model.quote(card, config) });
        exampleCache = { until: Date.now() + 10 * 60_000, rows };
        return send(200, { rows });
      }
      if (req.method === 'POST' && apiPath === '/api/cookie') {
        const cookie = normalizeCookieInput((await readJson(req)).cookie);
        if (!cookieLooksRight(cookie)) return send(400, { error: 'Paste a WikiMasters cookie or Copy as cURL text.' });
        const test = await session.constructor.test(cookie, { envFile: session.envFile, sessionFile: session.sessionFile });
        if (!test.ok || !test.id) return send(400, { error: `The site rejected that login (HTTP ${test.status}).` });
        const existingId = session.userId?.();
        if (existingId && existingId !== test.id)
          return send(409, { error: 'This bot slot already tracks a different account. Reconnect the same account to keep its state and history intact.' });
        if (accountConflicts(test.id, { account, sessions: Object.fromEntries(
          Object.entries(byAccount).map(([key, value]) => [key, value.session])) }))
          return send(409, { error: 'This account is already used by another bot. Connect a separate account.' });
        session.replaceCookie(cookie);
        engine.start?.();
        log(`${account} money bot connected as ${test.account ?? test.id}`);
        return send(200, { ok: true, account: test.account, balance: test.balance });
      }
      if (account === 'premium' && req.method === 'POST' && apiPath === '/api/switch-account') {
        const cookie = normalizeCookieInput((await readJson(req)).cookie);
        if (!cookieLooksRight(cookie)) return send(400, { error: 'Paste the new WikiMasters account cookie or Copy as cURL text.' });
        if (engine.getState().busy) return send(409, { error: 'The premium account is active; retry the switch after its current cycle finishes.' });
        if (premiumSettingsQueue?.pending()) return send(409, { error: 'Wait for queued premium settings to apply before switching accounts.' });
        if (settingsBusy) return send(409, { error: 'Another premium account update is in progress.' });
        const test = await session.constructor.test(cookie, { envFile: session.envFile, sessionFile: session.sessionFile });
        if (!test.ok || !test.id) return send(400, { error: `The site rejected that login (HTTP ${test.status}).` });
        if (session.userId?.() === test.id)
          return send(409, { error: 'This is already the connected premium account. Use Check & connect to refresh it without resetting state.' });
        if (accountConflicts(test.id, { account: 'premium', sessions: Object.fromEntries(
          Object.entries(byAccount).map(([key, value]) => [key, value.session])) }))
          return send(409, { error: 'This login is already used by another bot. Choose a separate account.' });
        if (typeof engine.resetForAccountSwitch !== 'function' || typeof selected.store?.archiveAndReset !== 'function')
          return send(409, { error: 'Premium account switching is unavailable in this running bot version.' });
        settingsBusy = true;
        try {
          const archived = await engine.resetForAccountSwitch(test.id);
          session.replaceCookie(cookie);
          log(`premium money account switched to ${test.account ?? test.id}; prior account archived as ${archived.key}`);
          return send(200, { ok: true, account: test.account, balance: test.balance,
            paused: true, archived });
        } finally { settingsBusy = false; }
      }
      if (req.method === 'POST' && apiPath === '/api/run') {
        await readJson(req);
        const result = await engine.runNow();
        return send(result?.ok === false ? 409 : 200, { ...result, state: engine.getState() });
      }
      if (req.method === 'POST' && apiPath === '/api/packs/retry') {
        await readJson(req);
        const result = engine.retryPacks();
        return send(result.ok ? 202 : 409, { ok: result.ok, queued: result.queued ?? false, error: result.error ?? null });
      }
      if (req.method === 'POST' && apiPath === '/api/verification/retry') {
        await readJson(req);
        const result = engine.retryVerification();
        return send(result.ok ? 202 : 409, result);
      }
      if (req.method === 'POST' && apiPath === '/api/pause') {
        await readJson(req);
        engine.pause();
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && apiPath === '/api/resume') {
        await readJson(req);
        engine.resume();
        return send(200, { ok: true });
      }
      const removeMatch = req.method === 'POST' && apiPath.match(/^\/api\/listings\/([a-zA-Z0-9-]+)\/remove$/);
      if (removeMatch) {
        await readJson(req);
        const result = await engine.removeListing(removeMatch[1]);
        return send(result.ok ? 200 : 409, result);
      }
      send(404, { error: 'not found' });
    } catch (error) {
      log(`dashboard ${url.pathname}: ${error.message}`);
      send(500, { error: error.message });
    }
  });
  server.on('close', () => premiumSettingsQueue?.close());
  server.listen(port, '127.0.0.1', () => log(`money dashboard: http://localhost:${port}`));
  return server;
}
