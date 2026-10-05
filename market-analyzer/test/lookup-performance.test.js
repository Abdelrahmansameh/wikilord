import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Analysis } from '../src/analysis.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-lookups-'));
  const store = new Store(path.join(dir, 'market.db'));
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, analysis: new Analysis(store) };
}

test('substring search reads the title index and retains exact IDs and distinct physical cards', (t) => {
  const { store, analysis } = fixture(t);
  store.db.exec(`INSERT INTO cards (id,title,times_sold,times_listed,summary) VALUES
    ('card-exact','Unrelated title',2,3,'Metadata'),
    ('card-1','Market Card',1,2,'Metadata'),
    ('card-2','Market Card',5,9,'Metadata'),
    ('card-3','A market card example',3,4,'Metadata');`);
  assert.deepEqual(analysis.cards('card-exact').map((r) => r.id), ['card-exact']);
  assert.deepEqual(analysis.cards('MARKET CARD').map((r) => r.id), ['card-2', 'card-1', 'card-3']);
  const sql = [...analysis.statements.keys()].find((sql) => sql.includes('SELECT rowid FROM cards'));
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ q: 'market card', prefix: 'market card%' }).map((r) => r.detail).join('\n');
  assert.match(plan, /SCAN cards USING COVERING INDEX cards_title/);
  assert.match(plan, /SEARCH cards USING INTEGER PRIMARY KEY/);
});

test('category trends use the indexed oldest timestamp without loading global diagnostic counts', (t) => {
  const { analysis, store } = fixture(t);
  const end = Date.now() - 1000;
  store.db.prepare(`INSERT INTO auctions (id,final,status,end_at,category,rarity,is_shiny,final_price)
    VALUES ('sale',1,'settled_sold',?,'Category','R',0,10)`).run(end);
  analysis.dbInfo = () => { throw new Error('Global counts must not run for category trends'); };
  const result = analysis.categoryGroups({ range: 'all', mode: 'exact' });
  assert.equal(result.groups[0].n, 1);
  assert.equal(analysis._rangeStart({ range: 'all' }), end);
});

test('category drill-down selects twelve sales before metadata and aggregates buyers before names', (t) => {
  const { store, analysis } = fixture(t);
  store.db.exec(`INSERT INTO users (id, username) VALUES ('buyer', 'Buyer');
    INSERT INTO category_tags (category, kind, tag, label) VALUES ('Category', 'theme', 'group', 'Group')`);
  const end = Date.now() - 1000;
  const insert = store.db.prepare(`INSERT INTO auctions
    (id, title, category, final, status, end_at, rarity, is_shiny, final_price, winner_id)
    VALUES (?, ?, 'Category', 1, ?, ?, ?, ?, ?, ?)`);
  for (let price = 1; price <= 30; price++)
    insert.run(`sale-${price}`, `Sale ${price}`, 'settled_sold', end, 'R', 0, price, 'buyer');
  insert.run('unknown', 'Unknown player', 'settled_sold', end, 'R', 0, 100, 'missing');
  insert.run('other-rarity', 'Other rarity', 'settled_sold', end, 'UR', 0, 200, 'buyer');
  insert.run('shiny', 'Shiny', 'settled_sold', end, 'R', 1, 300, 'buyer');
  insert.run('unsold', 'Unsold', 'settled_unsold', end, 'R', 0, null, 'buyer');
  for (const [mode, g] of [['exact', 'Category'], ['theme', 'group']]) {
    const result = analysis.categoryDetail({ range: '24h', rarity: 'R', shiny: '0', mode, g });
    assert.deepEqual(result.topSales.map(row => row.final_price), [100, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20]);
    assert.equal(result.topSales[0].winner, null);
    assert.equal(result.topSales[1].winner, 'Buyer');
    assert.deepEqual(result.buyers.map(row => ({ ...row })), [{ id: 'buyer', username: 'Buyer', won: 30, spent: 465 }]);
    assert.equal(result.byRarity[0].n, 32);
    assert.equal(result.byRarity[0].sold, 31);
  }
  const sql = [...analysis.statements.keys()].find(query => query.includes('WITH top AS MATERIALIZED'));
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ since: 0, r0: 'R', shiny: 0, g: 'Category' })
    .map(row => row.detail).join('\n');
  assert.match(plan, /MATERIALIZE top/);
  assert.match(plan, /USING COVERING INDEX auctions_dashboard/);
});
