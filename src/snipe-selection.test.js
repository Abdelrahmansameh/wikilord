import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapestPerCard } from './snipe-selection.js';

const candidate = (id, cardId, amount, endAt = '2026-10-01T10:00:00Z') => ({
  auction: { id, card_id: cardId, end_at: endAt },
  decision: { amount },
});

test('keeps only the cheapest bid for each card, even when it ends later', () => {
  const chosen = cheapestPerCard([
    candidate('first', 'cairo', 33),
    candidate('second', 'cairo', 150),
    candidate('third', 'giza', 76),
    candidate('fourth', 'giza', 3),
  ]);
  assert.deepEqual(chosen.map(({ auction }) => auction.id), ['first', 'fourth']);
});

test('chooses the earlier ending auction when bids match', () => {
  const chosen = cheapestPerCard([
    candidate('later', 'cairo', 20, '2026-10-01T11:00:00Z'),
    candidate('earlier', 'cairo', 20, '2026-10-01T09:00:00Z'),
  ]);
  assert.equal(chosen[0].auction.id, 'earlier');
});

test('compares card IDs, so different cards with the same title can both be sniped', () => {
  const chosen = cheapestPerCard([candidate('one', 'a', 5), candidate('two', 'b', 3)]);
  assert.equal(chosen.length, 2);
});
