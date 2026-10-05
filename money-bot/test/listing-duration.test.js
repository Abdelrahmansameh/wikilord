import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseListingDuration, summarizeListingDurations, DURATION_EXPERIMENT } from '../src/listing-duration.js';

test('duration randomization uses equal halves and preserves plans when disabled', () => {
  const enabled = { premium: { listingDurationExperiment: true } };
  assert.equal(chooseListingDuration(enabled, 60, () => 0), 10);
  assert.equal(chooseListingDuration(enabled, 60, () => 0.49999), 10);
  assert.equal(chooseListingDuration(enabled, 60, () => 0.5), 60);
  assert.equal(chooseListingDuration(enabled, 60, () => 0.99999), 60);
  assert.equal(chooseListingDuration({}, 60, () => { throw new Error('must not randomize'); }), 60);
});

test('duration comparison separates active, cancelled, legacy and purchased outcomes across restart', () => {
  const make = (id, minutes, status, extra = {}) => ({ auctionId: id, userCardId: `copy-${id}`,
    durationMinutes: minutes, durationExperiment: DURATION_EXPERIMENT, kind: 'premium',
    price: 100, finalPrice: 120, listingFee: 2, createdAt: 1000,
    endAt: 1000 + minutes * 60000, status, ...extra });
  const listings = {
    sold: make('sold', 10, 'settled_sold'),
    unsold: make('unsold', 10, 'settled_unsold'),
    active: make('active', 10, 'active', { listingFee: 999 }),
    cancelled: make('cancelled', 60, 'cancelled', { settledAt: 1000 + 300000 }),
    purchase: make('purchase', 60, 'settled_sold', { kind: 'purchase', endAt: 1000 + 3900000 }),
    legacy: make('legacy', 60, 'settled_sold', { durationExperiment: undefined }),
  };
  const purchases = { 'copy-purchase': { status: 'sold', saleAuctionId: 'purchase', realizedProfit: 42 } };
  const result = summarizeListingDurations(listings, purchases);
  assert.deepEqual(result, summarizeListingDurations(JSON.parse(JSON.stringify(listings)), purchases));
  const [short, long] = result.groups.all;
  assert.equal(short.placed, 3); assert.equal(short.active, 1);
  assert.equal(short.saleRate, 0.5); assert.equal(short.fees, 4);
  assert.equal(short.netProceeds, 116); assert.ok(Math.abs(short.netCoinsPerSlotHour - 348) < 1e-8);
  assert.equal(long.cancelled, 1); assert.equal(long.saleRate, 1);
  assert.equal(long.resaleProfit, 42); assert.equal(long.resaleProfitSales, 1);
  assert.ok(Math.abs(long.slotHours - 70 / 60) < 1e-8);
  assert.equal(result.groups.pack[1].sold, 0);
  assert.equal(result.groups.purchase[1].sold, 1);
  assert.equal(summarizeListingDurations().groups.all[0].saleRate, null);
});
