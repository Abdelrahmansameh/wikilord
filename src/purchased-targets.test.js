import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { wonCardIds } from './history.js';
import { decide } from './rules.js';
import { removePurchasedTargets } from './targets.js';

const bought = '11111111-1111-1111-1111-111111111111';
const wanted = '22222222-2222-2222-2222-222222222222';
const cfg = { global: { skipOwned: false }, rules: [{ name: 'wishlist', when: { wishlist: true }, bid: { max: 20 } }] };
const auction = (cardId) => ({ card_id: cardId, status: 'active', seller_id: 'seller', base_amount: 5, owned: false });
const target = (cardId, fields = {}) => ({ cardId, title: cardId, priority: 2, maxBid: 20, ...fields });

test('lifetime wins prevent re-buying traded-away cards after restart, while losses and packs remain eligible', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-purchases-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const history = path.join(dir, 'cards.jsonl');
  fs.writeFileSync(history, [
    JSON.stringify({ type: 'won', cardId: bought, at: '2020-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'lost', cardId: wanted }),
    JSON.stringify({ type: 'pack', cardId: wanted }),
    JSON.stringify({ type: 'traded', cardId: bought }),
    'incomplete record',
  ].join('\n'));
  // Read twice to represent a fresh process loading the same durable history.
  for (let restart = 0; restart < 2; restart++) {
    const purchases = wonCardIds(history);
    assert.deepEqual([...purchases], [bought]);
    const wishlist = new Set([bought, wanted]);
    const targets = new Map([[bought, target(bought)], [wanted, target(wanted)]]);
    assert.deepEqual(decide(cfg, auction(bought), 'me', wishlist, targets, purchases), { action: 'skip', reason: 'already bought by the bot' });
    assert.equal(decide(cfg, auction(bought), 'me', wishlist, new Map(), purchases).action, 'skip');
    assert.equal(decide(cfg, auction(wanted), 'me', wishlist, targets, purchases).action, 'bid');
    assert.equal(decide(cfg, auction(wanted), 'me', wishlist, new Map(), purchases).action, 'bid');
  }
});

test('fulfilled targets are removed whether unthemed, disabled, or fulfilled by a bid rule', () => {
  for (const fields of [{}, { theme: 'for-ahmed' }, { theme: 'for-ahmed', enabled: false }]) {
    const themes = { 'for-ahmed': { enabled: false, weeklyBudget: 50 } };
    const data = { themes, targets: [target(bought, fields), target(wanted, fields)] };
    assert.deepEqual(removePurchasedTargets(data, new Set([bought])), [target(bought, fields)]);
    assert.deepEqual(data.targets, [target(wanted, fields)]);
    assert.equal(data.themes, themes);
    assert.deepEqual(removePurchasedTargets(data, new Set([bought])), []);
  }
});

test('live target watcher persists cleanup at startup, on purchase, and when purchased targets are re-added', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-target-watcher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(new URL('./targets.js', import.meta.url), path.join(dir, 'src', 'targets.mjs'));
  fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify({ themes: { 'for-ahmed': { enabled: false } }, targets: [target(bought, { theme: 'for-ahmed' }), target(wanted)] }));
  const moduleUrl = pathToFileURL(path.join(dir, 'src', 'targets.mjs')).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { watchTargets, readTargets, writeTargets } from ${JSON.stringify(moduleUrl)};
    const purchases = new Set([${JSON.stringify(bought)}]);
    const book = watchTargets(() => {}, purchases);
    assert.equal(readTargets().targets.length, 1);
    assert.equal(book.data().targets[0].cardId, ${JSON.stringify(wanted)});
    purchases.add(${JSON.stringify(wanted)});
    book.reload();
    assert.deepEqual(readTargets().targets, []);
    const next = readTargets();
    next.targets.push(${JSON.stringify(target(bought))});
    writeTargets(next);
    book.reload();
    assert.deepEqual(book.data().targets, []);
    assert.deepEqual(readTargets().targets, []);
    assert.equal(readTargets().themes['for-ahmed'].enabled, false);
    assert.equal(fs.readFileSync(new URL('../journal.jsonl', ${JSON.stringify(moduleUrl)}), 'utf8').trim().split(String.fromCharCode(10)).length, 3);
  `], { stdio: 'pipe' });
});
