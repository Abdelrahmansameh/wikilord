import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard } from '../src/server.js';
import { JarvisTools } from '../../viewer/jarvis-tools.js';

test('Jarvis settings validate, preview, save and undo independently for both money accounts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-tool-settings-'));
  const standard = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url)));
  const premium = JSON.parse(fs.readFileSync(new URL('../premium.config.example.json', import.meta.url)));
  const standardFile = path.join(dir, 'standard.json'), premiumFile = path.join(dir, 'premium.json');
  fs.writeFileSync(standardFile, JSON.stringify(standard)); fs.writeFileSync(premiumFile, JSON.stringify(premium));
  const updates = { standard: [], premium: [] };
  const engine = (id) => ({ getState: () => ({ mode: 'dry-run', busy: false }), updateConfig: async (config) => { updates[id].push(config); } });
  const session = { hasCookie: () => false };
  const server = startDashboard({ config: { ui: { port: 0 } }, accounts: {
    standard: { engine: engine('standard'), session, config: standard, configFile: standardFile },
    premium: { engine: engine('premium'), session, config: premium, configFile: premiumFile },
  } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const tools = new JarvisTools({ money: base, stateDir: dir, getAccess: () => ({ approved: true, admin: true }) });
  const context = { chatId: 'admin', userId: 'admin' };
  try {
    const preview = await tools.execute('jarvis_money_settings_change', { account: 'standard', changes: [{ path: 'packs.maxPerCycle', value: 3 }], reason: 'Preview requested', preview: true }, context);
    assert.equal(preview.after.packs.maxPerCycle, 3);
    assert.equal(updates.standard.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(standardFile)).packs.maxPerCycle, 5);
    await assert.rejects(tools.execute('jarvis_money_settings_change', { account: 'standard', changes: [{ path: 'targetProbability', value: 0 }], reason: 'Invalid preview', preview: true }, context), /targetProbability/);
    const saved = await tools.execute('jarvis_money_settings_change', { account: 'standard', changes: [{ path: 'packs.maxPerCycle', value: 3 }], reason: 'User requested setting' }, context);
    assert.equal(updates.standard.length, 1); assert.equal(updates.premium.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(standardFile)).packs.maxPerCycle, 3);
    await tools.execute('jarvis_undo_change', { changeId: saved.changeId, reason: 'User requested undo' }, context);
    assert.equal(JSON.parse(fs.readFileSync(standardFile)).packs.maxPerCycle, 5);
    const premiumSave = await tools.execute('jarvis_money_settings_change', { account: 'premium', changes: [{ path: 'buy.minProfit', value: 300 }], reason: 'User requested margin' }, context);
    assert.equal(premiumSave.result.config.buy.minProfit, 300);
    assert.equal(updates.premium.length, 1);
    for (const setting of ['dryRun', 'marketDb', 'ui.port']) await assert.rejects(tools.execute('jarvis_money_settings_change', { account: 'premium', changes: [{ path: setting, value: false }], reason: 'Forbidden setting' }, context), /permissions/);
    const state = await (await fetch(`${base}/api/premium/settings`)).json();
    const stale = await fetch(`${base}/api/premium/settings`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-jarvis-settings': '1' },
      body: JSON.stringify({ version: state.version - 1, changes: [{ path: 'buy.minProfit', value: 350 }] }) });
    assert.equal(stale.status, 409);
    assert.equal(JSON.parse(fs.readFileSync(premiumFile)).buy.minProfit, 300);
    const unknown = await fetch(`${base}/api/premium/settings`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-jarvis-settings': '1' },
      body: JSON.stringify({ version: state.version, changes: [{ path: 'buy', value: { ...state.config.buy, marketDb: 'elsewhere' } }] }) });
    assert.equal(unknown.status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings application failure restores the durable config and leaves the account unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-settings-rollback-'));
  const config = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url)));
  const configFile = path.join(dir, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const engine = { getState: () => ({ busy: false }), updateConfig: async () => { throw new Error('engine rejected update'); } };
  const server = startDashboard({ config: { ui: { port: 0 } }, accounts: { standard: { engine, session: {}, config, configFile } } });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const current = await (await fetch(`${base}/api/settings`)).json();
    const response = await fetch(`${base}/api/settings`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ version: current.version, changes: [{ path: 'packs.enabled', value: false }] }) });
    assert.equal(response.status, 409);
    assert.equal(JSON.parse(fs.readFileSync(configFile)).packs.enabled, true);
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).config.packs.enabled, true);
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
