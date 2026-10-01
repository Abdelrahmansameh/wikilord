import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { Analysis } from '../src/analysis.js';

test('card search and stats isolate a physical card even when titles match', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-cards-'));
  const store = new Store(path.join(dir, 'test.db'));
  try {
    const now = Date.now();
    const card = store.db.prepare('INSERT INTO cards (id, title, rarity, is_shiny, q_score, times_sold, times_listed) VALUES (?, ?, ?, ?, ?, ?, ?)');
    card.run('card-a', 'Shared title', 'R', 0, 50, 2, 5);
    card.run('card-b', 'Shared title', 'R', 0, 50, 1, 1);
    const auction = store.db.prepare(`INSERT INTO auctions
      (id, card_id, status, final, final_price, base_amount, bid_count, winner_id, created_at, end_at, first_seen, last_seen, rarity, is_shiny, q_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'R', 0, 50)`);
    const put = (id, cardId, status, final, price, bids, minute) => auction.run(id, cardId, status, final, price,
      50, bids, price ? 'buyer-1' : null, now + minute * 60_000, now + (minute + 10) * 60_000,
      now + minute * 60_000, now + minute * 60_000);
    put('a1', 'card-a', 'settled_sold', 1, 100, 2, 1);
    put('a2', 'card-a', 'settled_sold', 1, 200, 3, 2);
    put('a3', 'card-a', 'settled_unsold', 1, null, 0, 3);
    put('a4', 'card-a', 'cancelled', 1, null, 0, 4);
    put('a5', 'card-a', 'active', 0, null, 0, 5);
    put('b1', 'card-b', 'settled_sold', 1, 999, 1, 6);

    const analysis = new Analysis(store);
    assert.deepEqual(analysis.cards('shared').map((r) => r.id), ['card-a', 'card-b']);
    assert.deepEqual(analysis.cards('card-b').map((r) => r.id), ['card-b']);
    assert.equal(analysis.cards('s').length, 0);
    assert.equal(analysis.card('missing'), null);
    const result = analysis.card('card-a', '1.9');
    assert.equal(result.history.page, 1);
    assert.equal(result.card.id, 'card-a');
    assert.deepEqual(result.history.rows.map((r) => r.id), ['a5', 'a4', 'a3', 'a2', 'a1']);
    assert.deepEqual(result.priceHistory.map((r) => r.price), [100, 200]);
    assert.deepEqual({ listings: result.stats.listings, sold: result.stats.sold, unsold: result.stats.unsold,
      cancelled: result.stats.cancelled, active: result.stats.active, median: result.stats.median,
      last: result.stats.last_sale_price, volume: result.stats.volume, bids: result.stats.total_bids },
      { listings: 5, sold: 2, unsold: 1, cancelled: 1, active: 1, median: 150, last: 200, volume: 300, bids: 5 });
    assert.equal(result.stats.sell_through, 2 / 3);
  } finally {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
