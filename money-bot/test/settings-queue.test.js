import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsQueue } from '../src/settings-queue.js';

async function until(check) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('queue did not settle'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-settings-queue-'));
  const file = path.join(dir, 'pending.json');
  return { file, clean: () => { for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name)); fs.rmdirSync(dir); } };
}
test('busy saves persist the latest settings across restart and apply once at idle', async () => {
  const f = fixture(); let busy = true, config = { a: 1, b: 2 }, calls = 0;
  const options = { file: f.file, delayMs: 5, getConfig: () => config, isBusy: () => busy,
    apply: async (next) => { assert.equal(busy, false); calls++; config = next; } };
  let queue = createSettingsQueue(options);
  try {
    queue.enqueue({ a: 3, b: 2 }); queue.enqueue({ a: 4, b: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 0); assert.equal(config.a, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).config.a, 4);
    queue.close(); queue = createSettingsQueue(options);
    assert.equal(queue.status().status, 'queued');
    busy = false; await until(() => queue.status().status === 'applied');
    assert.equal(config.a, 4); assert.equal(calls, 1); assert.equal(fs.existsSync(f.file), false);
    config = { a: 7, b: 2 }; assert.equal(queue.proposedConfig().a, 7);
  } finally { queue.close(); f.clean(); }
});
test('a newer save during application is retained and applied after the first finishes', async () => {
  const f = fixture(); let config = { n: 1 }, release; const calls = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = createSettingsQueue({ file: f.file, delayMs: 5, getConfig: () => config, isBusy: () => false,
    apply: async (next) => { calls.push(next.n); if (next.n === 2) await gate; config = next; } });
  try {
    queue.enqueue({ n: 2 }); await until(() => calls.length === 1);
    queue.enqueue({ n: 3 }); release();
    await until(() => queue.status().status === 'applied');
    assert.deepEqual(calls, [2, 3]); assert.equal(config.n, 3); assert.equal(fs.existsSync(f.file), false);
  } finally { release(); queue.close(); f.clean(); }
});
test('failure is visible and durable, and a new save can retry without overwriting external edits', async () => {
  const f = fixture(); let busy = true, config = { n: 1 }, fail = true;
  const queue = createSettingsQueue({ file: f.file, delayMs: 5, getConfig: () => config, isBusy: () => busy,
    validate: (next) => next.n < 0 ? ['invalid'] : [],
    apply: async (next) => { if (fail) throw new Error('replan failed'); config = next; } });
  try {
    queue.enqueue({ n: 2 }); assert.throws(() => queue.enqueue({ n: -1 }), /invalid/);
    busy = false; await until(() => queue.status().status === 'failed');
    assert.match(queue.status().error, /replan failed/); assert.equal(config.n, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).status, 'failed');
    fail = false; queue.enqueue({ n: 3 }); await until(() => queue.status().status === 'applied');
    assert.equal(config.n, 3);
    busy = true; queue.enqueue({ n: 4 }); config = { n: 99 }; busy = false;
    await until(() => queue.status().status === 'failed');
    assert.match(queue.status().error, /outside the queue/); assert.equal(config.n, 99);
  } finally { queue.close(); f.clean(); }
});
test('restart recognizes an already committed configuration without repeating application', async () => {
  const f = fixture(); let config = { n: 1 }, calls = 0;
  const options = { file: f.file, delayMs: 5, getConfig: () => config, isBusy: () => true, apply: async () => { calls++; } };
  let queue = createSettingsQueue(options);
  try {
    queue.enqueue({ n: 2 }); queue.close(); config = { n: 2 };
    queue = createSettingsQueue({ ...options, isBusy: () => false });
    await until(() => queue.status().status === 'applied');
    assert.equal(calls, 0); assert.equal(fs.existsSync(f.file), false);
  } finally { queue.close(); f.clean(); }
});
