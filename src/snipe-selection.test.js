import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapestPerCard } from './snipe-selection.js';

const candidate = (id, cardId, amount, endAt = '2026-10-01T10:00:00Z') => ({
  auction: { id, card_id: cardId, end_at: endAt },
  decision: { amount },
});

test('keeps one bid per card: the cheaper one when they end at the same time', () => {
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

test('takes the auction ending soonest when a later one is only a little cheaper (Dark and Darker: 11 now vs 10 later)', () => {
  const chosen = cheapestPerCard([
    candidate('soon', 'dad', 11, '2026-10-01T14:16:00Z'),
    candidate('later', 'dad', 10, '2026-10-01T16:30:00Z'),
  ]);
  assert.equal(chosen[0].auction.id, 'soon');
});

test('waits for a later listing that is clearly cheaper (150 now vs 33 later)', () => {
  const chosen = cheapestPerCard([
    candidate('expensive-soon', 'cairo', 150, '2026-10-01T09:00:00Z'),
    candidate('cheap-later', 'cairo', 33, '2026-10-01T11:00:00Z'),
  ]);
  assert.equal(chosen[0].auction.id, 'cheap-later');
});
