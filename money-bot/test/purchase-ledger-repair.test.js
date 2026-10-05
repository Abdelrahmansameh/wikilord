import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPurchaseLedgerRepairs, proposePurchaseLedgerRepairs } from '../tools/repair-purchase-ledger.mjs';

function fixture() {
  const facts = { cardId: 'card', rarity: 'R', shiny: false };
  const purchase = { ...facts, auctionId: 'buy', userCardId: 'original', purchasePrice: 60,
    accruedFees: 6, purchasedAt: 100, status: 'inventory', minProfit: 15,
    resalePlan: { ask: 100, attemptLimit: 6, stepDownPct: 0.08 } };
  const chain = [
    { auctionId: 'attempt-1', userCardId: 'original', createdAt: 110, endAt: 170, status: 'settled_unsold' },
    { auctionId: 'attempt-2', userCardId: 'return-1', createdAt: 180, endAt: 240, status: 'settled_unsold' },
    { auctionId: 'attempt-3', userCardId: 'return-2', createdAt: 250, endAt: 310,
      settledAt: 310, status: 'settled_sold', finalPrice: 100 },
  ].map((item) => ({ ...facts, ...item, title: 'Card', price: 100 }));
  const data = { accountId: 'bot', purchases: { original: purchase },
    bids: { buy: { ...facts, auctionId: 'buy', userCardId: 'original', status: 'won', amount: 60,
      purchasePrice: 60, placedAt: 90, ownedBeforeIds: [] } },
    listings: Object.fromEntries(chain.map((item) => [item.auctionId, item])),
    stats: { salesRevenue: 100, listingFees: 6 },
    lastUnsoldByCopy: { original: { price: 100, endAt: 170 }, 'return-1': { price: 100, endAt: 240 } },
    premiumCopies: {}, seenOwnedIds: ['original', 'return-1', 'return-2'] };
  const events = [
    { at: 100, type: 'deal-won', auctionId: 'buy', cardId: 'card', price: 60 },
    { at: 105, type: 'deal-purchase-matched', auctionId: 'buy', cardId: 'card', userCardId: 'original', price: 60 },
    ...chain.flatMap((item) => [
      { at: item.createdAt, type: 'listed', auctionId: item.auctionId, cardId: 'card', price: item.price },
      { at: item.endAt, type: 'auction-result', auctionId: item.auctionId, cardId: 'card',
        status: item.status, startPrice: 100, finalPrice: item.finalPrice ?? null,
        bids: item.status === 'settled_sold' ? [{ amount: 100, bidderId: 'external-buyer' }] : [] },
    ]),
  ];
  return { data, events };
}

test('ledger repair dry proposal is read-only and preserves costs, fees and resale plan when applied once', () => {
  const { data, events } = fixture();
  const before = structuredClone(data);
  const { repairs, rejected } = proposePurchaseLedgerRepairs(data, events);
  assert.equal(repairs.length, 1);
  assert.equal(rejected.length, 0);
  assert.deepEqual(data, before);
  assert.equal(repairs[0].realizedProfit, 34);
  const audit = applyPurchaseLedgerRepairs(data, repairs, { now: 400 });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].type, 'deal-ledger-repaired');
  assert.equal(data.purchases.original, undefined);
  const sold = data.purchases['return-2'];
  assert.equal(sold.status, 'sold');
  assert.equal(sold.purchasePrice, 60);
  assert.equal(sold.accruedFees, 6);
  assert.equal(sold.realizedProfit, 34);
  assert.equal(sold.saleAuctionId, 'attempt-3');
  assert.deepEqual(sold.resalePlan, before.purchases.original.resalePlan);
  assert.deepEqual(sold.previousUserCardIds, ['original', 'return-1']);
  assert.ok(Object.values(data.listings).every((item) => item.userCardId === 'return-2'));
  assert.equal(data.bids.buy.userCardId, 'return-2');
  assert.deepEqual(data.stats, before.stats); // Revenues were already recorded: no double count.
  assert.equal(data.lastUnsoldByCopy['return-2'].endAt, 240);
  assert.deepEqual(applyPurchaseLedgerRepairs(data, repairs, { now: 500 }), []);
  assert.deepEqual(proposePurchaseLedgerRepairs(data, events).repairs, []);
});

test('ledger repair rejects arrivals, accepted trades, duplicate acquisitions and overlapping listings', () => {
  for (const change of [
    ({ events }) => events.push({ at: 200, type: 'pack-opened', cards: [{ cardId: 'card' }] }),
    ({ events }) => events.push({ at: 200, type: 'pack-opened' }),
    ({ events }) => events.push({ at: 200, type: 'trade-offer-accepted' }),
    ({ data }) => data.bids.buy.ownedBeforeIds.push('pre-existing-copy'),
    ({ data }) => { data.purchases.second = { ...data.purchases.original, userCardId: 'second' }; },
    ({ data }) => { data.listings['attempt-2'].createdAt = 150; },
    ({ data }) => { data.listings['attempt-3'].rarity = 'SR'; },
    ({ events }) => { events.find((event) => event.auctionId === 'attempt-3' && event.type === 'auction-result').bids[0].bidderId = 'bot'; },
    ({ events }) => { events.splice(events.findIndex((event) => event.type === 'deal-purchase-matched'), 1); },
  ]) {
    const f = fixture();
    change(f);
    const proposal = proposePurchaseLedgerRepairs(f.data, f.events);
    assert.equal(proposal.repairs.length, 0);
    assert.ok(proposal.rejected.length > 0);
  }
});

test('unrelated pack cards do not invalidate an otherwise unique exact-variant ledger chain', () => {
  const { data, events } = fixture();
  events.push({ at: 200, type: 'pack-opened', cards: [{ cardId: 'another-card' }] });
  assert.equal(proposePurchaseLedgerRepairs(data, events).repairs.length, 1);
  assert.equal(proposePurchaseLedgerRepairs(data, events, { controlledUserIds: ['external-buyer'] }).repairs.length, 0);
});
