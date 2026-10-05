import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-db-perf-'));
  const file = path.join(dir, 'market.db');
  const logs = [];
  const state = { file, logs, store: new Store(file, { log: (line) => logs.push(line) }) };
  t.after(() => {
    state.store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return state;
}

test('dashboard aggregates use the covering index with bounded planner statistics', (t) => {
  const { store } = fixture(t);
  const insert = store.db.prepare(`INSERT INTO auctions
    (id, card_id, seller_id, winner_id, final, status, end_at, rarity, is_shiny, final_price,
      base_amount, bid_count, bidder_count, q_score, created_at, last_bid_at, category, pageviews, atk, def, title, search_doc)
    VALUES (?, 'card', ?, ?, 1, ?, ?, ?, 0, ?, 5, 2, 1, 90, 1, 2, 'Example', 100, 20, 30, ?, ?)`);
  store.tx(() => {
    for (let i = 0; i < 4000; i++) insert.run(`a${i}`, `seller${i % 7}`, `buyer${i % 11}`,
      i % 4 ? 'settled_sold' : 'settled_unsold', 1000 + i, i % 2 ? 'R' : 'C', i % 4 ? i % 100 : null,
      'A market card title for testing', 'Auction search text and card information. '.repeat(12));
    // The live collector has tens of thousands of pending rows: each final value exceeds the sample limit.
    const pending = store.db.prepare(`INSERT INTO auctions (id, final, status, end_at) VALUES (?, 0, 'active', 9999)`);
    for (let i = 0; i < 1500; i++) pending.run(`open${i}`);
    store.db.prepare(`INSERT INTO auctions (id, final, status, end_at) VALUES ('cancelled', 1, 'cancelled', 9999)`).run();
  });
  store.db.exec('PRAGMA analysis_limit = 1000; ANALYZE');
  const where = `final = 1 AND status IN ('settled_sold', 'settled_unsold') AND end_at >= 2000`;
  const queries = [
    `SELECT COUNT(*), SUM(bid_count), COUNT(DISTINCT winner_id), COUNT(DISTINCT seller_id),
      SUM(CASE WHEN status = 'settled_sold' THEN final_price END) FROM auctions WHERE ${where}`,
    `SELECT rarity, is_shiny, AVG(base_amount), AVG(bidder_count) FROM auctions WHERE ${where} GROUP BY rarity, is_shiny`,
    `SELECT category, COUNT(DISTINCT card_id), AVG(q_score), AVG(pageviews), AVG(end_at-last_bid_at)
      FROM auctions WHERE ${where} GROUP BY category`,
    `SELECT created_at, last_bid_at, atk, def, id FROM auctions WHERE ${where}`,
  ];
  for (const sql of queries) {
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).join('\n');
    assert.match(plan, /USING COVERING INDEX auctions_dashboard/, sql);
  }
  assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM auctions INDEXED BY auctions_dashboard
    WHERE final = 1 AND status IN ('settled_sold', 'settled_unsold')`).get().n, 4000);
  const feeds = `SELECT COALESCE(SUM(seen_recent_at IS NOT NULL), 0) recent_seen,
    COALESCE(SUM(seen_ending_at IS NOT NULL), 0) ending_seen,
    COALESCE(SUM(seen_recent_at IS NOT NULL AND seen_ending_at IS NOT NULL), 0) overlap FROM auctions`;
  assert.match(store.db.prepare(`EXPLAIN QUERY PLAN ${feeds}`).all().map(row => row.detail).join('\n'),
    /USING COVERING INDEX auctions_feed_seen/);
  const counts = store.db.prepare(feeds).get();
  assert.deepEqual({ ...counts }, { recent_seen: 0, ending_seen: 0, overlap: 0 });
});

test('an existing database builds and analyzes its dashboard index once, retaining records', (t) => {
  const state = fixture(t);
  state.store.db.prepare(`INSERT INTO auctions (id, final, status, final_price, end_at)
    VALUES ('sale', 1, 'settled_sold', 123, 1000)`).run();
  state.store.db.exec('DROP INDEX auctions_dashboard');
  state.store.db.close();
  state.logs.length = 0;
  state.store = new Store(state.file, { log: (line) => state.logs.push(line) });
  assert.equal(state.logs.length, 2);
  assert.match(state.logs[0], /building dashboard index/);
  assert.match(state.logs[1], /dashboard index ready in/);
  assert.equal(state.store.db.prepare(`SELECT final_price FROM auctions WHERE id = 'sale'`).get().final_price, 123);
  assert.ok(state.store.db.prepare(`SELECT 1 FROM sqlite_stat1 WHERE idx = 'auctions_dashboard'`).get());
  state.store.db.close();
  state.logs.length = 0;
  state.store = new Store(state.file, { log: (line) => state.logs.push(line) });
  assert.equal(state.logs.length, 0);
});

test('legacy bid index upgrades once and covers bidder statistics while retaining bids', (t) => {
  const state = fixture(t);
  state.store.db.exec(`INSERT INTO auctions (id, final, status, winner_id, end_at, last_bid_at)
    VALUES ('sale', 1, 'settled_sold', 'buyer', 1000, 900);
    INSERT INTO bids (id, auction_id, bidder_id, amount, placed_at) VALUES
    ('b1', 'sale', 'buyer', 123, 900), ('b2', 'sale', NULL, 100, 800);
    DROP INDEX bids_auction;
    CREATE INDEX bids_auction ON bids(auction_id, placed_at)`);
  state.store.db.close();
  state.logs.length = 0;
  state.store = new Store(state.file, { log: (line) => state.logs.push(line) });
  assert.equal(state.logs.length, 2);
  assert.match(state.logs[0], /upgrading bid lookup index/);
  assert.match(state.logs[1], /bid lookup index ready in/);
  assert.deepEqual(state.store.db.prepare('PRAGMA index_info(bids_auction)').all().map(column => column.name),
    ['auction_id', 'placed_at', 'bidder_id']);
  assert.equal(state.store.db.prepare('SELECT COUNT(*) n, SUM(amount) amount FROM bids').get().n, 2);
  assert.equal(state.store.db.prepare('SELECT SUM(amount) amount FROM bids').get().amount, 223);
  const sql = `WITH settled AS MATERIALIZED (
      SELECT id, end_at, last_bid_at, winner_id FROM auctions
      WHERE final = 1 AND status IN ('settled_sold', 'settled_unsold') ORDER BY id
    ) SELECT b.bidder_id, COUNT(*) bids, COUNT(DISTINCT b.auction_id) auctions,
      SUM(a.winner_id = b.bidder_id AND b.placed_at = a.last_bid_at) wins
    FROM settled a CROSS JOIN bids b ON b.auction_id = a.id GROUP BY b.bidder_id`;
  const plan = state.store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join('\n');
  assert.match(plan, /USING COVERING INDEX bids_auction/);
  assert.deepEqual(state.store.db.prepare(sql).all().map(row => ({ ...row })), [
    { bidder_id: null, bids: 1, auctions: 1, wins: 0 },
    { bidder_id: 'buyer', bids: 1, auctions: 1, wins: 1 },
  ]);
  state.store.db.close();
  state.logs.length = 0;
  state.store = new Store(state.file, { log: (line) => state.logs.push(line) });
  assert.equal(state.logs.length, 0);
});

test('ingestion diagnostics cache scout joins as well as historical counts', (t) => {
  const { store } = fixture(t);
  const start = Date.now() - 1000;
  store.setMeta('scout_mode_started_ms', start);
  const empty = store.ingestionInfo(300_000);
  assert.equal(empty.recent_seen, 0);
  assert.equal(empty.ending_seen, 0);
  assert.equal(empty.overlap, 0);
  assert.equal(empty.accounts.scout_only, 0);
  store.saveSnapshots([{ id: 'new', status: 'active', card_id: 'card', seller_id: 'seller',
    created_at: new Date().toISOString(), end_at: new Date(Date.now() + 60_000).toISOString() }], 'recent', 'tertiary');
  assert.strictEqual(store.ingestionInfo(300_000), empty, 'status polls reuse all diagnostics during the TTL');
  assert.equal(store.ingestionInfo().accounts.scout_only, 1, 'uncached calls still see new rows immediately');
  store._accountInfoCache.at = 0;
  assert.equal(store.ingestionInfo(300_000).recent_seen, 1, 'expired cache refreshes feeds and scout together');
});

test('scout diagnostics stream one grouped scan and filter overlaps before seeking auction metadata', (t) => {
  const { store } = fixture(t);
  store.setMeta('scout_mode_started_ms', 100);
  store.db.exec(`INSERT INTO auctions (id, first_seen, final) VALUES
    ('scout', 150, 1), ('overlap', 150, 1), ('older', 50, 1), ('unknown', 150, 0);
    INSERT INTO auction_account_seen (auction_id, slot, first_seen, last_seen) VALUES
    ('scout', 'tertiary', 150, 150), ('overlap', 'tertiary', 150, 150),
    ('overlap', 'primary', 50, 50), ('older', 'tertiary', 150, 150), ('unknown', 'tertiary', 150, 150)`);
  const sql = [];
  const db = store.db;
  const reader = { db: { prepare(query) { sql.push(query); return db.prepare(query); } } };
  const result = Store.prototype.ingestionInfo.call(reader);
  assert.equal(result.accounts.scout_only, 2);
  assert.equal(result.accounts.scout_only_final, 1);
  const scoutQuery = sql.find(query => query.includes('g.mask = 4'));
  assert.ok(scoutQuery);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${scoutQuery}`).all(100, 100).map(row => row.detail);
  assert.equal(plan[0], 'CO-ROUTINE g');
  assert.equal(plan.filter(step => step.includes('SCAN auction_account_seen')).length, 1);
  assert.ok(!plan.some(step => step.includes('MATERIALIZE') || step.includes('TEMP B-TREE')));
  const opcodes = db.prepare(`EXPLAIN ${scoutQuery}`).all(100, 100);
  const seek = opcodes.find(op => op.opcode === 'SeekGE');
  assert.ok(seek, 'exclusive candidates seek auction IDs');
  assert.ok(opcodes.some(op => op.opcode === 'Ne' && op.addr < seek.addr),
    'mask comparison runs before the auction lookup');
  assert.ok(opcodes.some(op => op.opcode === 'Lt' && op.addr < seek.addr),
    'tertiary first-seen comparison runs before the auction lookup');
  assert.ok(opcodes.some(op => op.opcode === 'IsNull' && op.addr < seek.addr && op.p2 > seek.addr),
    'ineligible CASE keys skip the auction ID index seek entirely');
});
