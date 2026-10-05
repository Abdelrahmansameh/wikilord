import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { applyOp, validateTargets } from '../src/targets.js';
import { validate as validateTradingConfig } from '../src/config.js';

export const JARVIS_TOOL_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (maxLength = 200) => ({ type: 'string', minLength: 1, maxLength });
const number = (minimum = 0, maximum = 1e12) => ({ type: 'number', minimum, maximum });
const integer = (minimum = 1, maximum = 100) => ({ type: 'integer', minimum, maximum });
const choice = (...values) => ({ type: 'string', enum: values });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items, maxItems = 100) => ({ type: 'array', items, minItems: 1, maxItems });
const bool = { type: 'boolean' };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const bot = text(40), cardId = { ...text(36), pattern: UUID.source }, account = choice('standard', 'premium');
const preview = { type: 'boolean', description: 'Validate and show changes without applying them.' };
const reason = text(500);
const changes = array(object({ path: text(100), value: {} }, ['path', 'value']), 50);
const targetOp = object({ op: choice('add', 'update', 'remove', 'theme', 'removeTheme'), cardId,
  title: text(300), rarity: choice('C', 'PC', 'R', 'SR', 'UR', 'L'), maxBid: number(1),
  priority: integer(1, 3), theme: nullable(text(40)), expires: nullable(text(40)), enabled: bool,
  counters: nullable(integer(0, 20)), reason, name: text(40), weeklyBudget: nullable(number()),
  note: text(500), withTargets: bool }, ['op']);
const tool = (name, description, inputSchema) => ({ type: 'function', name, description, inputSchema });

export const JARVIS_TOOLS = [
  tool('jarvis_project_info', 'Read one of the fixed public project guides to answer questions about how the bots work. No arbitrary file paths or credentials.', object({ guide: choice('trading', 'policies', 'agent', 'market', 'money') }, ['guide'])),
  tool('jarvis_bots', 'List registered trading bots and money accounts and your current read/write permissions. Call this to resolve the bot/account before acting.', object({})),
  tool('jarvis_trading_read', 'Read a trading bot: status, targets, themes, collection, upcoming plans, settings, hard limits, journal, or card history. Results include live spending constraints.', object({ bot, view: choice('status', 'targets', 'themes', 'collection', 'plans', 'settings', 'limits', 'journal', 'history'), theme: text(40), query: text(100), type: choice('won', 'lost', 'sold', 'recycled', 'listed', 'pack'), days: integer(1, 365), limit: integer(1, 100) }, ['bot', 'view'])),
  tool('jarvis_trading_catalog', 'Search the game catalog through a registered trading bot. Use results to resolve an exact target card ID; a search may contact the game.', object({ bot, query: text(100), category: text(100), rarity: choice('C', 'PC', 'R', 'SR', 'UR', 'L'), limit: integer(1, 50) }, ['bot', 'query'])),
  tool('jarvis_targets_change', 'Add, update, enable/disable, remove, or bulk-edit targets; create/update/remove themes. Add needs cardId, title, maxBid; update/remove need cardId; themes need name. All changes obey hard limits. Use only for changes the user requested; preview is available.', object({ bot, operations: array(targetOp), reason, preview }, ['bot', 'operations', 'reason'])),
  tool('jarvis_theme_rename', 'Rename a theme and move its targets without changing their prices/priorities or the theme budget.', object({ bot, from: text(40), to: text(40), reason, preview }, ['bot', 'from', 'to', 'reason'])),
  tool('jarvis_target_prices', 'Review or apply a pricing rule to selected targets using exact rarity/shiny recorded sales. Defaults to preview. Skips sparse/stale history and obeys hard bid limits. cardIds or theme must explicitly select the targets.', object({ bot, cardIds: array(cardId), theme: text(40), statistic: choice('p25', 'median', 'p75'), factor: number(0.1, 2), minSales: integer(4, 10000), days: integer(1, 365), preview, reason }, ['bot', 'statistic', 'reason'])),
  tool('jarvis_trading_settings_change', 'Patch approved trading settings or complete rule arrays using path/value changes, e.g. global.dailySpendCap or rules. Refuses infrastructure changes, live activation, weakened protections, and hard-limit violations.', object({ bot, changes, reason, preview }, ['bot', 'changes', 'reason'])),
  tool('jarvis_trading_control', 'Pause/resume a named trading bot, request an auction/wishlist scan, or retry packs after human verification. Auction scans can schedule live activity under existing bot rules.', object({ bot, action: choice('pause', 'resume', 'scan', 'retry_packs'), scan: choice('auctions', 'wishlist'), reason }, ['bot', 'action', 'reason'])),
  tool('jarvis_wishlist_change', 'Add or remove one card from the selected trading bot wishlist.', object({ bot, cardId, enabled: bool, reason }, ['bot', 'cardId', 'enabled', 'reason'])),
  tool('jarvis_market_read', 'Read the analyzer dashboard data: search cards, inspect a card or auction, compare similar sales, browse auctions, rankings, players, categories, overview, prices, timing, or health. Never changes the database. Card details use recorded all-time history.', object({ view: choice('search_cards', 'card', 'auction', 'auctions', 'comparable', 'rankings', 'players', 'users', 'categories', 'category_detail', 'overview', 'prices', 'timing', 'health'), query: text(100), id: text(128), cardId: text(128), user: text(128), range: choice('1h', '6h', '24h', '7d', '30d', 'all'), rarity: choice('C', 'PC', 'R', 'SR', 'UR', 'L'), shiny: bool, page: integer(1, 10000), sort: choice('sold', 'listed', 'median', 'volume', 'price', 'bids', 'resold', 'recent'), status: choice('sold', 'unsold', 'active', 'cancelled'), minPrice: number(), qScore: number(0, 100), band: number(0, 50), days: integer(1, 365), mode: choice('exact', 'word'), group: text(200), limit: integer(1, 100) }, ['view'])),
  tool('jarvis_market_prices', 'Read sale statistics for 1-30 exact card IDs, separately by rarity/shiny: count, median/quartiles, min/max, recent sold prices and latest sale date. Shows sparse and stale groups. Can compare multiple cards.', object({ cardIds: array(cardId, 30), days: integer(1, 365) }, ['cardIds'])),
  tool('jarvis_market_query', 'Run a bounded structured read-only database report. Choose a fixed table, columns, filters, grouping and count/sum/avg/min/max metrics. No raw SQL, files, joins, writes or extensions. Auctions expose recorded outcomes; use status=settled_sold and final=1 for actual sales.', object({ table: choice('auctions', 'cards', 'bids', 'users'), columns: array(text(40), 12), filters: array(object({ field: text(40), op: choice('eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'), value: {} }, ['field', 'op', 'value']), 20), groupBy: array(text(40), 8), metrics: array(object({ function: choice('count', 'sum', 'avg', 'min', 'max'), field: text(40), as: text(40) }, ['function', 'field', 'as']), 8), minimumCount: integer(1, 1000000), orderBy: text(40), descending: bool, limit: integer(1, 100) }, ['table'])),
  tool('jarvis_money_read', 'Read standard or premium money-account status, listings, decisions/quotes, accounting/profit, history, settings, premium deals or snipe history.', object({ account, view: choice('status', 'listings', 'decisions', 'profit', 'history', 'settings', 'deals', 'snipes', 'listing_details', 'deal_details'), id: text(128), query: text(100), category: choice('all', 'packs', 'listings', 'recycling', 'alerts', 'deals'), before: integer(0, Number.MAX_SAFE_INTEGER), limit: integer(1, 100) }, ['account', 'view'])),
  tool('jarvis_money_settings_change', 'Update approved settings for one money account, including packs/listing controls and premium profit targets, reserves, buying, selling, trades and counterbids. Cannot change accounts/database/ports or activate live mode.', object({ account, changes, reason, preview }, ['account', 'changes', 'reason'])),
  tool('jarvis_money_control', 'Pause/resume one money account, retry packs after human verification, or run a normal cycle. A cycle can sell/recycle/bid under the account existing live rules.', object({ account, action: choice('pause', 'resume', 'retry_packs', 'run_cycle'), reason }, ['account', 'action', 'reason'])),
  tool('jarvis_money_remove_listing', 'Remove one specified listing from the selected money account through its existing guarded control. Removal may incur fees and cannot be undone by Jarvis.', object({ account, auctionId: text(128), reason }, ['account', 'auctionId', 'reason'])),
  tool('jarvis_changes', 'Read the tool change history, including actor, requested action and actual before/after settings. Only successful reversible changes can be undone.', object({ limit: integer(1, 30) })),
  tool('jarvis_undo_change', 'Undo a successful target/theme or settings change by its changeId. Refuses if the bot state has changed since that action, or permission was revoked. Cannot undo bids, sales, recycling, listings or runtime controls.', object({ changeId: text(36), reason }, ['changeId', 'reason'])),
];

const specs = new Map(JARVIS_TOOLS.map((spec) => [spec.name, spec]));
const TABLES = {
  auctions: ['id', 'card_id', 'title', 'category', 'rarity', 'is_shiny', 'q_score', 'pageviews', 'atk', 'def', 'status', 'final', 'final_price', 'base_amount', 'current_bid', 'bid_count', 'created_at', 'end_at', 'first_seen', 'last_seen', 'seller_id', 'winner_id'],
  cards: ['id', 'title', 'category', 'rarity', 'is_shiny', 'q_score', 'pageviews', 'atk', 'def', 'times_sold', 'times_listed', 'updated_at'],
  bids: ['id', 'auction_id', 'bidder_id', 'amount', 'placed_at'], users: ['id', 'username'],
};
const TRADING_ROOTS = new Set(['timing', 'global', 'rules', 'targets', 'packs', 'recycle', 'sell']);
const MONEY_ROOTS = new Set(['cycleMinutes', 'maxActionsPerCycle', 'actionGapMs', 'packs', 'listing', 'replacement', 'targetProbability', 'outcomePenalty', 'modelLowerPenalty', 'modelUpperBonus', 'arrivalWindowHours', 'minArrivalObservations', 'maxMarketAgeHours', 'modelRefreshMinutes', 'premium', 'buy', 'trades']);

function assertJson(value, depth = 0) {
  if (depth > 12) throw new Error('Arguments are nested too deeply.');
  if (value && typeof value === 'object') for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe argument key.');
    assertJson(value[key], depth + 1);
  }
}

export function validateArguments(value, schema, label = 'arguments') {
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => { try { validateArguments(value, s, label); return true; } catch { return false; } })) throw new Error(`${label}: invalid value.`);
    return;
  }
  const type = schema.type;
  if (type === 'null' && value !== null || type === 'string' && typeof value !== 'string'
      || type === 'boolean' && typeof value !== 'boolean' || type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))
      || type === 'array' && !Array.isArray(value) || ['number', 'integer'].includes(type) && (typeof value !== 'number' || !Number.isFinite(value) || type === 'integer' && !Number.isInteger(value))) throw new Error(`${label}: expected ${type}.`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label}: unsupported value.`);
  if (typeof value === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value))) throw new Error(`${label}: invalid text.`);
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new Error(`${label}: outside permitted range.`);
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${label}: missing ${key}.`);
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) { if (schema.additionalProperties === false) throw new Error(`${label}: unknown field ${key}.`); }
      else validateArguments(child, schema.properties[key], `${label}.${key}`);
    }
  }
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${label}: invalid number of items.`);
    value.forEach((child, i) => validateArguments(child, schema.items, `${label}[${i}]`));
  }
}

function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Jarvis bot connections must be fixed local HTTP origins.');
  return url.origin;
}

export function tradingRegistry(env = process.env) {
  const configured = env.JARVIS_TRADING_BOTS ? JSON.parse(env.JARVIS_TRADING_BOTS) : { main: env.VIEWER_BOT_URL || 'http://127.0.0.1:8787' };
  if (!configured || typeof configured !== 'object' || Array.isArray(configured) || Object.keys(configured).length > 20) throw new Error('Invalid Jarvis trading bot registry.');
  return Object.fromEntries(Object.entries(configured).map(([name, url]) => {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) throw new Error('Invalid registered trading bot name.');
    return [name, localUrl(url)];
  }));
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:cookie|token|secret|password|authorization|session_data)/i.test(key)).map(([key, child]) => [key, scrub(child)]));
  if (typeof value === 'string') return value.replace(/Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  return value;
}

function bounded(value, maxRows = 100) {
  if (Array.isArray(value)) return value.slice(0, maxRows).map((child) => bounded(child, maxRows));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, bounded(child, maxRows)]));
  return typeof value === 'string' && value.length > 4000 ? `${value.slice(0, 4000)} [shortened]` : value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function patchSettings(config, changes, roots) {
  const next = structuredClone(config);
  for (const { path: settingPath, value } of changes) {
    const keys = settingPath.split('.');
    if (!roots.has(keys[0]) || keys.some((key) => !/^[A-Za-z][A-Za-z0-9]*$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key))) throw new Error(`Setting ${settingPath} is outside Jarvis permissions.`);
    let part = next;
    for (const key of keys.slice(0, -1)) {
      if (!part[key] || typeof part[key] !== 'object' || Array.isArray(part[key])) throw new Error(`Unknown setting ${settingPath}.`);
      part = part[key];
    }
    if (!Object.hasOwn(part, keys.at(-1))) throw new Error(`Unknown setting ${settingPath}.`);
    part[keys.at(-1)] = structuredClone(value);
  }
  return next;
}

export function buildMarketQuery(args) {
  const fields = TABLES[args.table];
  if (!fields) throw new Error('Unknown market table.');
  const field = (name) => { if (!fields.includes(name)) throw new Error(`Unsupported ${args.table} column ${name}.`); return `"${name}"`; };
  const groups = args.groupBy ?? [];
  const metrics = args.metrics ?? [];
  if (groups.length && !metrics.length) throw new Error('Grouped reports need a metric.');
  if (metrics.length && args.columns?.some((name) => !groups.includes(name))) throw new Error('Report columns must belong to groupBy.');
  const aliases = new Set();
  const select = (metrics.length ? groups : args.columns ?? fields.slice(0, 6)).map(field);
  for (const metric of metrics) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(metric.as) || aliases.has(metric.as) || fields.includes(metric.as)) throw new Error('Invalid or duplicate metric alias.');
    aliases.add(metric.as);
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(metric.function)) throw new Error('Unsupported metric.');
    const column = metric.field === '*' && metric.function === 'count' ? '*' : field(metric.field);
    select.push(`${metric.function.toUpperCase()}(${column}) AS "${metric.as}"`);
  }
  const params = [], where = [];
  for (const filter of args.filters ?? []) {
    const column = field(filter.field);
    if (filter.op === 'in') {
      if (!Array.isArray(filter.value) || !filter.value.length || filter.value.length > 50 || filter.value.some((v) => !['string', 'number'].includes(typeof v))) throw new Error('in needs 1-50 scalar values.');
      where.push(`${column} IN (${filter.value.map(() => '?').join(',')})`); params.push(...filter.value);
    } else if (filter.op === 'contains') {
      if (typeof filter.value !== 'string' || filter.value.length > 100) throw new Error('contains needs short text.');
      where.push(`instr(lower(${column}), lower(?)) > 0`); params.push(filter.value);
    } else {
      const op = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.op];
      if (!op || !['string', 'number', 'boolean'].includes(typeof filter.value)) throw new Error('Filters need a supported operator and scalar value.');
      where.push(`${column} ${op} ?`); params.push(typeof filter.value === 'boolean' ? Number(filter.value) : filter.value);
    }
  }
  let sql = `SELECT ${select.join(', ')} FROM "${args.table}"`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  if (groups.length) sql += ` GROUP BY ${groups.map(field).join(', ')}`;
  if (args.minimumCount != null) {
    if (!metrics.length) throw new Error('minimumCount needs an aggregate report.');
    sql += ' HAVING COUNT(*) >= ?'; params.push(args.minimumCount);
  }
  if (args.orderBy) {
    if (metrics.length && !aliases.has(args.orderBy) && !groups.includes(args.orderBy)) throw new Error('orderBy must name a report output.');
    sql += ` ORDER BY ${aliases.has(args.orderBy) ? `"${args.orderBy}"` : field(args.orderBy)} ${args.descending ? 'DESC' : 'ASC'}`;
  }
  sql += ' LIMIT ?'; params.push(args.limit ?? 50);
  return { sql, params };
}

export class JarvisTools {
  constructor({ getAccess, stateDir, trading = tradingRegistry(), market = process.env.VIEWER_MARKET_URL || 'http://127.0.0.1:8788',
    money = process.env.VIEWER_MONEY_URL || 'http://127.0.0.1:8789', marketDb = process.env.WM_MARKET_DB || fileURLToPath(new URL('../market-analyzer/market.db', import.meta.url)),
    fetchImpl = fetch, queryImpl, auditImpl, queryTimeoutMs = 30_000 } = {}) {
    this.getAccess = getAccess;
    this.trading = Object.fromEntries(Object.entries(trading).map(([id, url]) => [id, localUrl(url)]));
    this.market = localUrl(market); this.money = localUrl(money); this.marketDb = marketDb;
    this.fetch = fetchImpl; this.queryImpl = queryImpl; this.auditImpl = auditImpl; this.queryTimeoutMs = queryTimeoutMs;
    this.auditPath = stateDir ? path.join(stateDir, 'jarvis-changes.jsonl') : null;
    this.locks = new Map(); this.runningQueries = 0;
  }

  resources() { return [...Object.keys(this.trading).map((id) => `trading:${id}`), 'money:standard', 'money:premium']; }

  access(context, resource, write = false) {
    if (!context?.chatId || context.isActive?.() === false) throw new Error('This Jarvis request is no longer active.');
    const access = this.getAccess?.(context.chatId);
    if (!access?.approved) throw new Error('Jarvis access expired or was revoked.');
    if (write && !access.admin && !(access.grants ?? []).includes(resource)) throw new Error(`You have read-only access to ${resource}. Ask the admin to grant this bot/account.`);
    return access;
  }

  async request(base, endpoint, { method = 'GET', body, params, context, resource, write = false } = {}) {
    if (context) this.access(context, resource, write);
    const url = new URL(endpoint, `${base}/`);
    if (url.origin !== base || !url.pathname.startsWith('/api/')) throw new Error('Unsupported bot endpoint.');
    for (const [key, value] of Object.entries(params ?? {})) if (value != null) url.searchParams.set(key, String(value));
    const response = await this.fetch(url.href, { method, headers: { 'content-type': 'application/json', origin: base, 'x-bot-ui': '1', ...(body?.changes ? { 'x-jarvis-settings': '1' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(35_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false || data.error) throw new Error(String(data.error ?? data.errors?.join('; ') ?? `Bot request failed (${response.status}).`).slice(0, 800));
    return data;
  }

  async query(sql, params = []) {
    if (this.queryImpl) return this.queryImpl(sql, params);
    if (this.runningQueries >= 2) throw new Error('Two market reports are already running. Try again shortly.');
    this.runningQueries++;
    try {
      return await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./jarvis-market-worker.js', import.meta.url), { workerData: { file: this.marketDb, sql, params }, resourceLimits: { maxOldGenerationSizeMb: 96 } });
        let settled = false;
        const finish = (error, rows) => {
          if (settled) return; settled = true; clearTimeout(timer); void worker.terminate();
          if (error) reject(error); else resolve(rows);
        };
        const timer = setTimeout(() => finish(new Error('Read-only market query timed out; narrow the filters.')), this.queryTimeoutMs);
        worker.on('message', (result) => finish(result.error ? new Error(result.error) : null, result.rows));
        worker.on('error', () => finish(new Error('The read-only market database is unavailable.')));
        worker.on('exit', () => { if (!settled) finish(new Error('Market query worker stopped.')); });
      });
    } finally { this.runningQueries--; }
  }

  audit(entry) {
    const safe = scrub({ at: new Date().toISOString(), ...entry });
    if (this.auditImpl) return this.auditImpl(safe);
    if (!this.auditPath) throw new Error('Jarvis change history is not configured.');
    fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
    fs.appendFileSync(this.auditPath, JSON.stringify(safe) + '\n');
  }

  history() {
    if (!this.auditPath || !fs.existsSync(this.auditPath)) return [];
    // Read only the tail: a growing audit journal must not consume unbounded memory.
    const fd = fs.openSync(this.auditPath, 'r');
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - 2_000_000);
      const bytes = Buffer.alloc(size - start); fs.readSync(fd, bytes, 0, bytes.length, start);
      let lines = bytes.toString('utf8').split('\n'); if (start) lines = lines.slice(1);
      return lines.filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } finally { fs.closeSync(fd); }
  }

  async locked(key, callback) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(callback); this.locks.set(key, result);
    try { return await result; } finally { if (this.locks.get(key) === result) this.locks.delete(key); }
  }

  async change(context, resource, action, reason, before, after, apply, isPreview = false, reversible = false) {
    this.access(context, resource, !isPreview);
    if (isPreview) return { preview: true, resource, before, after };
    const changeId = randomUUID();
    const entry = { changeId, chatId: context.chatId, userId: context.userId, requestId: context.requestId, resource, action, reason, before, after, reversible };
    this.audit({ ...entry, status: 'requested' }); // Fail closed if the record cannot be saved.
    let result;
    try {
      this.access(context, resource, true); // Re-check immediately before mutation, including after queued waits.
      result = await apply();
    } catch (error) {
      try { this.audit({ ...entry, status: 'failed', error: String(error.message).slice(0, 800) }); } catch {}
      throw error;
    }
    try { this.audit({ ...entry, status: 'applied', result }); }
    catch {
      // The action already completed. Reporting a failure could cause it to be repeated.
      return { changeId, resource, before, after, result, reversible: false,
        warning: 'The action completed, but saving its completion record failed. Do not repeat it. Inspect the current bot state; automatic undo is unavailable for this action.' };
    }
    return { changeId, resource, before, after, result, reversible };
  }

  base(botId) {
    if (!Object.hasOwn(this.trading, botId)) throw new Error(`Unknown trading bot ${botId}. Call jarvis_bots first.`);
    return this.trading[botId];
  }

  async execute(name, args, context) {
    if (!specs.has(name)) throw new Error('This tool is not available to Jarvis.');
    assertJson(args); validateArguments(args, specs.get(name).inputSchema);
    if (JSON.stringify(args).length > 64_000) throw new Error('Tool arguments are too large.');
    this.access(context);
    const result = await this.dispatch(name, args, context);
    this.access(context);
    return scrub(bounded(result, args.limit ?? 100));
  }

  async prices(ids, days = 30) {
    const rows = await this.query(`SELECT card_id, MAX(title) title, rarity, is_shiny, final_price price, COUNT(*) n, MAX(end_at) lastSaleAt
      FROM auctions WHERE card_id IN (${ids.map(() => '?').join(',')}) AND final = 1 AND status = 'settled_sold'
      AND final_price IS NOT NULL AND end_at >= ? GROUP BY card_id, rarity, is_shiny, final_price ORDER BY final_price LIMIT 20001`, [...ids, Date.now() - days * 86400_000]);
    if (rows.length > 20000) throw new Error('Too many distinct prices; use fewer cards or a shorter period.');
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.card_id}|${row.rarity}|${row.is_shiny}`;
      if (!groups.has(key)) groups.set(key, { cardId: row.card_id, title: row.title, rarity: row.rarity, shiny: Boolean(row.is_shiny), n: 0, frequencies: [], lastSaleAt: 0 });
      const group = groups.get(key); group.n += row.n; group.frequencies.push(row); group.lastSaleAt = Math.max(group.lastSaleAt, row.lastSaleAt);
    }
    const quantile = (group, p) => {
      const position = (group.n - 1) * p; let count = 0, low, high;
      for (const row of group.frequencies) {
        if (Math.floor(position) >= count && Math.floor(position) < count + row.n) low = row.price;
        if (Math.ceil(position) >= count && Math.ceil(position) < count + row.n) high = row.price;
        count += row.n;
      }
      return Math.round((low + (high - low) * (position % 1)) * 10) / 10;
    };
    const summaries = [...groups.values()].map((group) => ({ cardId: group.cardId, title: group.title, rarity: group.rarity, shiny: group.shiny, n: group.n,
      min: group.frequencies[0].price, p25: quantile(group, 0.25), median: quantile(group, 0.5), p75: quantile(group, 0.75), max: group.frequencies.at(-1).price,
      lastSaleAt: group.lastSaleAt, sparse: group.n < 4, stale: group.lastSaleAt < Date.now() - 7 * 86400_000 }));
    const recent = await this.query(`SELECT card_id cardId, rarity, is_shiny shiny, final_price price, end_at at FROM (
      SELECT card_id, rarity, is_shiny, final_price, end_at, ROW_NUMBER() OVER (PARTITION BY card_id, rarity, is_shiny ORDER BY end_at DESC) rn
      FROM auctions WHERE card_id IN (${ids.map(() => '?').join(',')}) AND final = 1 AND status = 'settled_sold' AND final_price IS NOT NULL AND end_at >= ?)
      WHERE rn <= 5 ORDER BY end_at DESC LIMIT 1080`, [...ids, Date.now() - days * 86400_000]);
    return { days, groups: summaries.map((group) => ({ ...group, recent: recent.filter((row) => row.cardId === group.cardId && row.rarity === group.rarity && Boolean(row.shiny) === group.shiny) })), missing: ids.filter((id) => !summaries.some((group) => group.cardId === id)), recordedOnly: true };
  }

  async targetChange(a, context) {
    const base = this.base(a.bot), resource = `trading:${a.bot}`;
    return this.locked(resource, async () => {
      this.access(context, resource, a.preview !== true);
      const current = await this.request(base, '/api/targets');
      if (a.expectedHash && hash(current.data) !== a.expectedHash) throw new Error('Targets changed while this action was being prepared.');
      const limits = await this.request(base, '/api/limits');
      const after = structuredClone(current.data);
      for (const op of a.operations) {
        if (['add', 'update', 'remove'].includes(op.op) && !UUID.test(op.cardId ?? '')) throw new Error('Target operations need an exact card ID.');
        if (['theme', 'removeTheme'].includes(op.op) && !op.name) throw new Error('Theme operations need a name.');
        applyOp(after, op, { limits, by: 'jarvis' });
      }
      const errors = validateTargets(after); if (errors.length) throw new Error(errors.join('; '));
      return this.change(context, resource, 'targets', a.reason, current.data, after,
        async () => {
          const response = await this.request(base, '/api/targets', { method: 'POST', body: { version: current.version, ops: a.operations, by: 'jarvis' }, context, resource, write: true });
          if (response.data) Object.assign(after, response.data);
          else try {
            const saved = await this.request(base, '/api/targets');
            // Capture the bot's actual timestamps/defaults for conflict-safe undo.
            Object.assign(after, saved.data);
          } catch { return { ...response, warning: 'Changes were saved, but reading back the targets failed. Check the current target list before another edit.' }; }
          return response;
        }, a.preview === true, true);
    });
  }

  async dispatch(name, a, context) {
    if (name === 'jarvis_bots') {
      const access = this.access(context);
      return { role: access.admin ? 'admin' : 'approved', bots: this.resources().map((resource) => ({ resource, read: true, write: access.admin || (access.grants ?? []).includes(resource) })), market: { read: true, write: false } };
    }
    if (name === 'jarvis_project_info') {
      const guides = { trading: '../README.md', policies: '../POLICIES.md', agent: '../AGENT.md', market: '../market-analyzer/README.md', money: '../money-bot/README.md' };
      return { guide: a.guide, text: fs.readFileSync(new URL(guides[a.guide], import.meta.url), 'utf8').slice(0, 24000) };
    }
    if (name === 'jarvis_market_query') { const query = buildMarketQuery(a); return { rows: await this.query(query.sql, query.params), recordedOnly: true, limit: a.limit ?? 50 }; }
    if (name === 'jarvis_market_prices') return this.prices([...new Set(a.cardIds)], a.days);
    if (name === 'jarvis_market_read') {
      const route = { search_cards: 'cards', card: 'card', auction: 'auction', auctions: 'auctions', comparable: 'comparable', rankings: 'card-rankings', players: 'players', users: 'users', categories: 'category-groups', category_detail: 'category-detail', overview: 'overview', prices: 'prices', timing: 'timing', health: 'status' }[a.view];
      if (['card', 'auction'].includes(a.view) && !a.id) throw new Error('This lookup needs id.');
      if (a.view === 'comparable' && (!a.rarity || a.shiny === undefined || a.qScore === undefined)) throw new Error('Comparable sales need rarity, shiny and qScore.');
      if (a.view === 'category_detail' && !a.group) throw new Error('Category detail needs group.');
      return this.request(this.market, `/api/${route}`, { params: { q: a.query, id: a.id, card: a.cardId, user: a.user, range: a.range ?? '7d', rarity: a.rarity,
        shiny: a.shiny === undefined ? undefined : Number(a.shiny), page: a.page, sort: a.sort, status: a.status, minPrice: a.minPrice, q_score: a.qScore, band: a.band, days: a.days, mode: a.mode, group: a.group } });
    }
    if (name === 'jarvis_targets_change') return this.targetChange(a, context);
    if (name === 'jarvis_theme_rename') {
      const current = await this.request(this.base(a.bot), '/api/targets');
      if (!Object.hasOwn(current.data.themes, a.from) || Object.hasOwn(current.data.themes, a.to)) throw new Error('The old theme must exist and the new name must be unused.');
      const theme = current.data.themes[a.from];
      const operations = [{ op: 'theme', name: a.to, weeklyBudget: theme.weeklyBudget ?? null, enabled: theme.enabled !== false, ...(theme.note ? { note: theme.note } : {}) },
        ...current.data.targets.filter((target) => target.theme === a.from).map((target) => ({ op: 'update', cardId: target.cardId, theme: a.to })), { op: 'removeTheme', name: a.from }];
      if (operations.length > 100) throw new Error('This theme has too many targets to rename in one operation.');
      return this.targetChange({ ...a, operations, expectedHash: hash(current.data) }, context);
    }
    if (name === 'jarvis_target_prices') {
      if (!a.cardIds && !a.theme) throw new Error('Select cardIds or one theme explicitly.');
      const current = await this.request(this.base(a.bot), '/api/targets');
      const selected = current.data.targets.filter((target) => (!a.cardIds || a.cardIds.includes(target.cardId)) && (!a.theme || target.theme === a.theme));
      if (!selected.length || selected.length > 30) throw new Error('Select between 1 and 30 existing targets.');
      const prices = await this.prices(selected.map((target) => target.cardId), a.days);
      const operations = [], skipped = [];
      const metadata = await this.query(`SELECT id, rarity, is_shiny FROM cards WHERE id IN (${selected.map(() => '?').join(',')}) LIMIT 30`, selected.map((target) => target.cardId));
      const limits = await this.request(this.base(a.bot), '/api/limits');
      for (const target of selected) {
        const card = metadata.find((row) => row.id === target.cardId);
        const group = card && prices.groups.find((row) => row.cardId === target.cardId && row.rarity === (target.rarity ?? card.rarity) && row.shiny === Boolean(card.is_shiny));
        if (!group || group.n < (a.minSales ?? 4) || group.stale) { skipped.push({ cardId: target.cardId, title: target.title, reason: 'Not enough recent sales for the exact variant.' }); continue; }
        const maxBid = Math.max(1, Math.min(Math.floor(group[a.statistic] * (a.factor ?? 1)), limits.maxBidPerCard ?? Infinity));
        operations.push({ op: 'update', cardId: target.cardId, maxBid, reason: a.reason });
      }
      if (!operations.length) return { preview: a.preview !== false, operations, skipped };
      return { ...await this.targetChange({ ...a, operations, preview: a.preview !== false, expectedHash: hash(current.data) }, context), priceEvidence: prices.groups, skipped };
    }
    if (name.startsWith('jarvis_trading_') || name === 'jarvis_wishlist_change') {
      const base = this.base(a.bot), resource = `trading:${a.bot}`;
      if (name === 'jarvis_trading_catalog') return this.request(base, '/api/catalog', { params: { text: a.query, category: a.category, rarity: a.rarity, limit: a.limit ?? 25 } });
      if (name === 'jarvis_trading_read') {
        if (a.view === 'settings') return (await this.request(base, '/api/config')).config;
        if (a.view === 'limits') return this.request(base, '/api/limits');
        if (a.view === 'journal') return this.request(base, '/api/journal', { params: { limit: a.limit ?? 30 } });
        if (a.view === 'history') return this.request(base, '/api/cards-history', { params: { type: a.type, q: a.query, days: a.days ?? 7, limit: a.limit ?? 50 } });
        if (a.view === 'collection') return this.request(base, '/api/values');
        const report = await this.request(base, '/api/report');
        if (a.view === 'targets') return { targets: report.targets?.filter((target) => (!a.theme || target.theme === a.theme) && (!a.query || target.title.toLowerCase().includes(a.query.toLowerCase()))) ?? [] };
        if (['themes', 'plans'].includes(a.view)) return { [a.view]: report[a.view] ?? [] };
        return report;
      }
      if (name === 'jarvis_trading_settings_change') return this.locked(resource, async () => {
        this.access(context, resource, a.preview !== true);
        const current = await this.request(base, '/api/config'), limits = await this.request(base, '/api/limits');
        if (a.expectedHash && hash(current.config) !== a.expectedHash) throw new Error('Settings changed while this action was being prepared.');
        const next = patchSettings(current.config, a.changes, TRADING_ROOTS);
        const errors = validateTradingConfig(next); if (errors.length) throw new Error(errors.join('; '));
        for (const [section, allowed] of Object.entries({ global: ['skipOwned', 'reserveBalance', 'dailySpendCap', 'maxSnipesPerHour', 'minGapBetweenBidsMs', 'counters'], targets: ['enabled', 'increment', 'counters', 'searchEveryScan', 'reserveHorizonHours'] })) {
          for (const key of Object.keys(next[section] ?? {})) if (!allowed.includes(key) && !Object.hasOwn(current.config[section] ?? {}, key)) throw new Error(`Unknown ${section} setting.`);
        }
        const checkNumbers = (value) => {
          if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 1e12)) throw new Error('Trading settings require finite, nonnegative numbers within the supported range.');
          if (value && typeof value === 'object') Object.values(value).forEach(checkNumbers);
        };
        a.changes.forEach((change) => checkNumbers(change.value));
        if (next.rules.length > 100 || next.recycle.rules.length > 100 || (next.sell?.rules.length ?? 0) > 100) throw new Error('Rule lists are limited to 100 entries.');
        if (current.config.global.skipOwned && next.global.skipOwned !== true) throw new Error('Jarvis cannot disable owned-card protection.');
        if (limits.maxDailySpend != null && next.global.dailySpendCap > limits.maxDailySpend || limits.minReserve != null && next.global.reserveBalance < limits.minReserve
          || limits.maxBidPerCard != null && next.rules.some((rule) => rule.bid?.max > limits.maxBidPerCard)) throw new Error('These settings exceed the owner hard limits.');
        return this.change(context, resource, 'trading_settings', a.reason, current.config, next,
          () => this.request(base, '/api/config', { method: 'PUT', body: { version: current.version, config: next }, context, resource, write: true }), a.preview === true, true);
      });
      if (name === 'jarvis_trading_control' || name === 'jarvis_wishlist_change') return this.locked(resource, () => {
        const endpoint = name === 'jarvis_wishlist_change' ? '/api/wishlist' : { pause: '/api/pause', resume: '/api/pause', scan: '/api/scan', retry_packs: '/api/packs/retry' }[a.action];
        const body = name === 'jarvis_wishlist_change' ? { cardId: a.cardId, on: a.enabled } : ['pause', 'resume'].includes(a.action) ? { paused: a.action === 'pause' } : a.action === 'scan' ? { what: a.scan ?? 'auctions' } : {};
        return this.change(context, resource, name === 'jarvis_wishlist_change' ? 'wishlist' : a.action, a.reason, null, body,
          () => this.request(base, endpoint, { method: 'POST', body, context, resource, write: true }));
      });
    }
    if (name.startsWith('jarvis_money_')) {
      const resource = `money:${a.account}`, prefix = a.account === 'premium' ? '/api/premium' : '/api';
      if (name === 'jarvis_money_read') {
        if (['deals', 'snipes', 'deal_details'].includes(a.view) && a.account !== 'premium') throw new Error('Deal tools are available on the premium account.');
        if (a.view === 'history') return this.request(this.money, `${prefix}/history`, { params: { q: a.query, category: a.category, before: a.before } });
        if (a.view === 'settings') return this.request(this.money, `${prefix}/settings`);
        if (a.view === 'deals') return this.request(this.money, `${prefix}/deals`);
        if (a.view === 'snipes') return this.request(this.money, `${prefix}/snipe-history`, { params: { before: a.before } });
        if (['listing_details', 'deal_details'].includes(a.view)) {
          if (!a.id || !/^[a-zA-Z0-9-]+$/.test(a.id)) throw new Error('Provide a valid auction/listing id.');
          return this.request(this.money, `${prefix}/${a.view === 'listing_details' ? 'listings' : 'deals'}/${a.id}/details`);
        }
        const state = await this.request(this.money, `${prefix}/state`);
        if (a.view === 'profit') return { account: a.account, balance: state.balance, accounting: state.accounting, stats: state.stats, deals: state.deals, period: 'account recorded lifetime; inspect history for individual events' };
        if (a.view === 'listings') return { listings: state.activeListings, slots: state.slots };
        if (a.view === 'decisions') return { decisions: state.decisions, decisionsAt: state.decisionsAt };
        return state;
      }
      if (name === 'jarvis_money_settings_change') return this.locked(resource, async () => {
        this.access(context, resource, a.preview !== true);
        const current = await this.request(this.money, `${prefix}/settings`);
        const config = current.config;
        if (!config) throw new Error('The money bot needs its updated settings endpoint; restart the money bot.');
        if (current.sourceChanged) throw new Error('The money config was edited outside the running engine. Restart that process before changing settings.');
        if (a.expectedHash && hash(config) !== a.expectedHash) throw new Error('Settings changed while this action was being prepared.');
        const roots = new Set([...MONEY_ROOTS].filter((key) => a.account === 'premium' || !['premium', 'buy', 'trades'].includes(key)));
        const next = patchSettings(config, a.changes, roots);
        // Validate through the engine endpoint even for previews; this does not save or run a cycle.
        await this.request(this.money, `${prefix}/settings`, { method: 'POST', body: { version: current.version, changes: a.changes, preview: true }, context, resource });
        return this.change(context, resource, 'money_settings', a.reason, config, next,
          () => this.request(this.money, `${prefix}/settings`, { method: 'POST', body: { version: current.version, changes: a.changes, preview: a.preview === true }, context, resource, write: true }), a.preview === true, true);
      });
      return this.locked(resource, () => {
        let endpoint;
        if (name === 'jarvis_money_remove_listing') {
          if (!/^[a-zA-Z0-9-]+$/.test(a.auctionId)) throw new Error('Invalid listing id.');
          endpoint = `${prefix}/listings/${a.auctionId}/remove`;
        } else endpoint = `${prefix}/${{ pause: 'pause', resume: 'resume', retry_packs: 'packs/retry', run_cycle: 'run' }[a.action]}`;
        return this.change(context, resource, a.action ?? 'remove_listing', a.reason, null, { account: a.account, auctionId: a.auctionId },
          () => this.request(this.money, endpoint, { method: 'POST', body: {}, context, resource, write: true }));
      });
    }
    if (name === 'jarvis_changes') {
      const access = this.access(context);
      return this.history().filter((entry) => entry.status === 'applied' && (access.admin || entry.chatId === context.chatId)).slice(-(a.limit ?? 10)).reverse();
    }
    if (name === 'jarvis_undo_change') return this.undo(a, context);
    throw new Error('Unsupported Jarvis action.');
  }

  async undo(a, context) {
    const entry = this.history().findLast((row) => row.changeId === a.changeId && row.status === 'applied');
    if (!entry?.reversible) throw new Error('This change is not available for undo.');
    this.access(context, entry.resource, true);
    if (entry.action === 'targets') {
      const botId = entry.resource.slice('trading:'.length), current = await this.request(this.base(botId), '/api/targets');
      if (hash(current.data) !== hash(entry.after)) throw new Error('Targets changed since this action; review the current targets first.');
      const operations = [];
      for (const target of current.data.targets) if (!entry.before.targets.some((row) => row.cardId === target.cardId)) operations.push({ op: 'remove', cardId: target.cardId });
      for (const [name, theme] of Object.entries(entry.before.themes)) operations.push({ op: 'theme', name, weeklyBudget: theme.weeklyBudget ?? null, enabled: theme.enabled !== false, note: theme.note ?? '' });
      for (const target of entry.before.targets) {
        operations.push({ op: 'add', cardId: target.cardId, title: target.title, ...(target.rarity ? { rarity: target.rarity } : {}), maxBid: target.maxBid, priority: target.priority, theme: target.theme ?? null, reason: target.reason ?? '', expires: target.expires ?? null });
        operations.push({ op: 'update', cardId: target.cardId, theme: target.theme ?? null, enabled: target.enabled !== false, counters: target.counters ?? null });
      }
      for (const name of Object.keys(current.data.themes)) if (!Object.hasOwn(entry.before.themes, name)) operations.push({ op: 'removeTheme', name });
      if (operations.length > 100) throw new Error('This change needs more than 100 undo operations; edit the affected targets explicitly.');
      return this.targetChange({ bot: botId, operations, expectedHash: hash(entry.after), reason: `Undo ${a.changeId}: ${a.reason}` }, context);
    }
    if (entry.action === 'trading_settings') {
      const botId = entry.resource.slice('trading:'.length), current = await this.request(this.base(botId), '/api/config');
      if (hash(current.config) !== hash(entry.after)) throw new Error('Settings changed since this action.');
      const changes = Object.keys(entry.before).filter((key) => hash(entry.before[key]) !== hash(entry.after[key])).map((key) => ({ path: key, value: entry.before[key] }));
      return this.dispatch('jarvis_trading_settings_change', { bot: botId, changes, expectedHash: hash(entry.after), reason: `Undo ${a.changeId}: ${a.reason}` }, context);
    }
    if (entry.action === 'money_settings') {
      const moneyAccount = entry.resource.slice('money:'.length), prefix = moneyAccount === 'premium' ? '/api/premium' : '/api';
      const current = await this.request(this.money, `${prefix}/settings`);
      if (hash(current.config) !== hash(entry.after)) throw new Error('Settings changed since this action.');
      const changes = Object.keys(entry.before).filter((key) => hash(entry.before[key]) !== hash(entry.after[key])).map((key) => ({ path: key, value: entry.before[key] }));
      return this.dispatch('jarvis_money_settings_change', { account: moneyAccount, changes, expectedHash: hash(entry.after), reason: `Undo ${a.changeId}: ${a.reason}` }, context);
    }
    throw new Error('This action cannot be undone.');
  }
}
