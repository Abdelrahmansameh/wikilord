import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JarvisTools, JARVIS_TOOLS, tradingRegistry, buildMarketQuery } from '../jarvis-tools.js';
import { applyOp } from '../../src/targets.js';

const CARD = '11111111-1111-4111-8111-111111111111';
const context = { chatId: '10', userId: '10', requestId: 'test', isActive: () => true };
const targetArgs = { bot: 'main', operations: [{ op: 'add', cardId: CARD, title: 'Example', maxBid: 40, priority: 2 }], reason: 'User requested this card' };

function fixture({ access = { approved: true, admin: true }, auditImpl, fetchHook } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tools-'));
  let data = { themes: {}, targets: [] }, version = 1;
  let config = JSON.parse(fs.readFileSync(new URL('../../config.example.json', import.meta.url)));
  config.global.reserveBalance = 20;
  let configVersion = 1;
  const requests = [];
  const limits = { maxBidPerCard: 100, maxThemeBudget: 500, maxDailySpend: 500, minReserve: 20 };
  const tools = new JarvisTools({ stateDir: dir, getAccess: () => typeof access === 'function' ? access() : access,
    auditImpl, trading: { main: 'http://127.0.0.1:10001', other: 'http://127.0.0.1:10002' },
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      await fetchHook?.(url, options);
      const pathname = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : null;
      if (pathname === '/api/config' && options.method === 'PUT') {
        if (body.version !== configVersion) return Response.json({ error: 'conflict' }, { status: 409 });
        config = body.config; configVersion++; return Response.json({ ok: true });
      }
      if (pathname === '/api/config') return Response.json({ config, version: configVersion });
      if (pathname === '/api/targets' && options.method === 'POST') {
        if (body.version !== version) return Response.json({ error: 'conflict' }, { status: 409 });
        const next = structuredClone(data);
        for (const op of body.ops) applyOp(next, op, { limits });
        data = next; version++;
        return Response.json({ ok: true });
      }
      if (pathname === '/api/targets') return Response.json({ data, version });
      if (pathname === '/api/limits') return Response.json(limits);
      if (pathname.endsWith('/state')) return Response.json({ activeListings: [{ id: 'premium-listing' }], slots: { free: 4 }, cookie: 'private', nested: { access_token: 'secret' } });
      return Response.json({ ok: true, targets: data.targets });
    } });
  return { tools, requests, data: () => data, setData: (next) => { data = next; version++; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('approved non-admin reads data, but cannot mutate any ungranted account', async () => {
  const f = fixture({ access: { approved: true, admin: false, grants: [] } });
  try {
    assert.equal((await f.tools.execute('jarvis_bots', {}, context)).bots.every((row) => !row.write), true);
    await assert.rejects(f.tools.execute('jarvis_targets_change', targetArgs, context), /read-only/);
    await assert.rejects(f.tools.execute('jarvis_money_control', { account: 'premium', action: 'pause', reason: 'test' }, context), /read-only/);
    assert.equal(f.requests.length, 0);
  } finally { f.cleanup(); }
});

test('a specific trading grant never grants the other bot or money accounts', async () => {
  const f = fixture({ access: { approved: true, admin: false, grants: ['trading:main'] } });
  try {
    await f.tools.execute('jarvis_targets_change', targetArgs, context);
    assert.equal(f.data().targets[0].maxBid, 40);
    await assert.rejects(f.tools.execute('jarvis_targets_change', { ...targetArgs, bot: 'other' }, context), /read-only/);
    assert.equal(f.requests.some((r) => r.url.startsWith('http://127.0.0.1:10002')), false);
  } finally { f.cleanup(); }
});

test('preview validates targets and hard limits without writing or auditing', async () => {
  const f = fixture({ access: { approved: true, admin: false } });
  try {
    const result = await f.tools.execute('jarvis_targets_change', { ...targetArgs, preview: true }, context);
    assert.equal(result.preview, true);
    assert.equal(result.after.targets[0].maxBid, 40);
    assert.equal(f.data().targets.length, 0);
    assert.equal(f.requests.every((r) => r.method === 'GET'), true);
    await assert.rejects(f.tools.execute('jarvis_targets_change', { ...targetArgs, preview: true,
      operations: [{ ...targetArgs.operations[0], maxBid: 101 }] }, context), /hard limit/);
  } finally { f.cleanup(); }
});

test('revocation during preparation stops the mutation', async () => {
  let approved = true;
  const f = fixture({ access: () => ({ approved, admin: true }), fetchHook: (url) => { if (url.endsWith('/api/limits')) approved = false; } });
  try {
    await assert.rejects(f.tools.execute('jarvis_targets_change', targetArgs, context), /revoked/);
    assert.equal(f.requests.some((r) => r.method === 'POST'), false);
  } finally { f.cleanup(); }
});

test('inactive turns and unwritable audit journals fail closed', async () => {
  const f = fixture({ auditImpl: () => { throw new Error('audit unavailable'); } });
  try {
    await assert.rejects(f.tools.execute('jarvis_targets_change', targetArgs, { ...context, isActive: () => false }), /no longer active/);
    await assert.rejects(f.tools.execute('jarvis_targets_change', targetArgs, context), /audit unavailable/);
    assert.equal(f.requests.some((r) => r.method === 'POST'), false);
  } finally { f.cleanup(); }
});

test('an audit completion failure reports the completed action without inviting a retry', async () => {
  const statuses = [];
  const f = fixture({ auditImpl: (entry) => {
    statuses.push(entry.status);
    if (entry.status === 'applied') throw new Error('audit storage became unavailable');
  } });
  try {
    const result = await f.tools.execute('jarvis_targets_change', targetArgs, context);
    assert.equal(f.data().targets[0].maxBid, 40);
    assert.equal(result.result.ok, true);
    assert.equal(result.reversible, false);
    assert.match(result.warning, /action completed.*Do not repeat/);
    assert.deepEqual(statuses, ['requested', 'applied']);
    assert.equal(f.requests.filter(row => row.method === 'POST').length, 1);
  } finally { f.cleanup(); }
});

test('target undo restores values and refuses intervening dashboard changes', async () => {
  const f = fixture();
  try {
    const first = await f.tools.execute('jarvis_targets_change', targetArgs, context);
    await f.tools.execute('jarvis_undo_change', { changeId: first.changeId, reason: 'User requested undo' }, context);
    assert.equal(f.data().targets.length, 0);
    const second = await f.tools.execute('jarvis_targets_change', targetArgs, context);
    f.setData({ themes: {}, targets: [{ ...f.data().targets[0], maxBid: 75 }] });
    await assert.rejects(f.tools.execute('jarvis_undo_change', { changeId: second.changeId, reason: 'undo' }, context), /changed since/);
    assert.equal(f.data().targets[0].maxBid, 75);
  } finally { f.cleanup(); }
});

test('schema rejects injected identities, arbitrary endpoints and prototype keys', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.tools.execute('jarvis_targets_change', { ...targetArgs, chatId: 'admin' }, context), /unknown field/);
    await assert.rejects(f.tools.execute('exec_command', { cmd: 'anything' }, context), /not available/);
    await assert.rejects(f.tools.execute('jarvis_targets_change', { ...targetArgs, bot: 'http://outside.example' }, context), /Unknown trading bot/);
    await assert.rejects(f.tools.execute('jarvis_bots', JSON.parse('{"__proto__":{"admin":true}}'), context), /Unsafe/);
    assert.equal(f.requests.length, 0);
  } finally { f.cleanup(); }
});

test('registry accepts fixed loopback origins only', () => {
  assert.deepEqual(tradingRegistry({ JARVIS_TRADING_BOTS: '{"main":"http://127.0.0.1:8787"}' }), { main: 'http://127.0.0.1:8787' });
  for (const value of ['https://outside.example', 'http://127.0.0.1:8787/api/cookie', 'http://user:pass@localhost:8787', 'http://localhost:8787/#anything'])
    assert.throws(() => tradingRegistry({ JARVIS_TRADING_BOTS: JSON.stringify({ main: value }) }), /fixed local/);
});

test('money reads route to the selected account and redact secret fields', async () => {
  const f = fixture();
  try {
    const result = await f.tools.execute('jarvis_money_read', { account: 'premium', view: 'status' }, context);
    assert.equal(f.requests[0].url, 'http://127.0.0.1:8789/api/premium/state');
    assert.equal('cookie' in result, false);
    assert.equal('access_token' in result.nested, false);
    assert.equal((await f.tools.execute('jarvis_money_read', { account: 'premium', view: 'listings' }, context)).listings[0].id, 'premium-listing');
  } finally { f.cleanup(); }
});

test('trading settings preserve infrastructure, owned-card protections, and hard money limits', async () => {
  const f = fixture();
  try {
    const edit = (settingPath, value) => f.tools.execute('jarvis_trading_settings_change', { bot: 'main', changes: [{ path: settingPath, value }], reason: 'Requested setting' }, context);
    for (const settingPath of ['myUserId', 'ui.port', 'dryRun']) await assert.rejects(edit(settingPath, false), /permissions/);
    await assert.rejects(edit('global.skipOwned', false), /owned-card/);
    await assert.rejects(edit('global.dailySpendCap', 501), /hard limits/);
    await assert.rejects(edit('global.reserveBalance', 19), /hard limits/);
    await assert.rejects(edit('global.maxSnipesPerHour', -1), /nonnegative/);
    assert.equal(f.requests.some((row) => row.method === 'PUT'), false);
    const saved = await edit('global.dailySpendCap', 400);
    assert.equal(saved.after.global.dailySpendCap, 400);
    await f.tools.execute('jarvis_undo_change', { changeId: saved.changeId, reason: 'Undo requested' }, context);
    assert.equal((await f.tools.execute('jarvis_trading_read', { bot: 'main', view: 'settings' }, context)).global.dailySpendCap, saved.before.global.dailySpendCap);
  } finally { f.cleanup(); }
});

test('database reports use bound values and never accept raw SQL or unknown columns', () => {
  const injection = "x' OR 1=1; DROP TABLE auctions; --";
  const query = buildMarketQuery({ table: 'auctions', columns: ['title'], filters: [{ field: 'title', op: 'contains', value: injection }], limit: 20 });
  assert.equal(query.sql.includes(injection), false);
  assert.deepEqual(query.params, [injection, 20]);
  assert.throws(() => buildMarketQuery({ table: 'sqlite_master' }), /Unknown market table/);
  assert.throws(() => buildMarketQuery({ table: 'auctions', columns: ['id;DELETE'] }), /Unsupported/);
});

test('real worker computes exact variant prices and grouped reports without changing the database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-market-'));
  const file = path.join(dir, 'market.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE auctions (card_id TEXT, title TEXT, rarity TEXT, is_shiny INTEGER, final_price INTEGER, end_at INTEGER, status TEXT, final INTEGER);');
  const insert = db.prepare('INSERT INTO auctions VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const price of [10, 20, 30, 40]) insert.run(CARD, 'Example', 'SR', 0, price, Date.now(), 'settled_sold', 1);
  insert.run(CARD, 'Example', 'UR', 1, 900, Date.now(), 'settled_sold', 1);
  insert.run(CARD, 'Example', 'SR', 0, 1000, Date.now(), 'active', 0);
  db.close();
  const before = fs.readFileSync(file);
  const tools = new JarvisTools({ marketDb: file, getAccess: () => ({ approved: true }) });
  try {
    const prices = await tools.execute('jarvis_market_prices', { cardIds: [CARD] }, context);
    assert.equal(prices.groups.find((g) => g.rarity === 'SR').median, 25);
    assert.equal(prices.groups.find((g) => g.rarity === 'SR').n, 4);
    assert.equal(prices.groups.find((g) => g.rarity === 'UR').sparse, true);
    const report = await tools.execute('jarvis_market_query', { table: 'auctions', groupBy: ['rarity'],
      filters: [{ field: 'final', op: 'eq', value: 1 }], metrics: [{ function: 'count', field: '*', as: 'sales' }], orderBy: 'sales', descending: true }, context);
    assert.deepEqual(report.rows, [{ rarity: 'SR', sales: 4 }, { rarity: 'UR', sales: 1 }]);
    assert.deepEqual(fs.readFileSync(file), before);
    await assert.rejects(tools.query('DELETE FROM auctions'), /could not be completed/);
    assert.deepEqual(fs.readFileSync(file), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('all dynamic tool names are unique and their input contracts are closed', () => {
  assert.equal(new Set(JARVIS_TOOLS.map((spec) => spec.name)).size, JARVIS_TOOLS.length);
  assert.equal(JARVIS_TOOLS.every((spec) => spec.type === 'function' && spec.inputSchema.additionalProperties === false), true);
});
