import test from 'node:test';
import assert from 'node:assert/strict';
import { findExternalPurchaseListings, nextResaleAttempt, remapReturnedPurchases, resaleHorizon } from '../src/resale-policy.js';

test('resale horizon discounts retry correlation and charges attempts until first sale', () => {
  const independent = resaleHorizon(0.6, 6, 0);
  const correlated = resaleHorizon(0.6, 6, 0.5);
  assert.ok(correlated.probability > 0.6 && correlated.probability < independent.probability);
  assert.ok(correlated.expectedAttempts > independent.expectedAttempts);
  assert.equal(resaleHorizon(0.6, 6, 1).probability, 0.6);
  assert.equal(resaleHorizon(0, 6, 0.5).expectedAttempts, 6);
  assert.equal(resaleHorizon(1, 6, 0.5).expectedAttempts, 1);
  assert.ok(Math.abs(correlated.saleProbabilities.reduce((sum, p) => sum + p, 0) - correlated.probability) < 1e-12);
});

test('resale attempt prices step down, include all fees and respect absolute and ROI profit floors', () => {
  const purchase = { userCardId: 'copy', purchasePrice: 60, minProfit: 15, minRoi: 0.25,
    accruedFees: 4, purchasedAt: 1, resalePlan: { ask: 100, attemptLimit: 3, stepDownPct: 0.1 } };
  const failed = (i, price = 100) => ({ auctionId: `failed-${i}`, userCardId: 'copy',
    status: 'settled_unsold', price, createdAt: 2, endAt: 3 + i });
  assert.equal(nextResaleAttempt(purchase, [], { listingFee: 2 }).price, 100);
  assert.equal(nextResaleAttempt(purchase, [failed(1)]).price, 90);
  assert.equal(nextResaleAttempt(purchase, [failed(1), failed(2, 90)], { listingFee: 2 }).price, 81);
  assert.equal(nextResaleAttempt(purchase, [failed(1), failed(2, 70)], { listingFee: 2 }).price, 81);
  assert.equal(nextResaleAttempt(purchase, [failed(1), failed(1)]).failureCount, 1);
  assert.equal(nextResaleAttempt(purchase, [failed(1), failed(2), failed(3)]).exhausted, true);
});

test('cheap openings fall once, preserve fees and profit, and leave premium asks unchanged', () => {
  const purchase = { userCardId: 'cheap', lane: 'liquid', purchasePrice: 13,
    minProfit: 15, minRoi: 0.25, accruedFees: 0, purchasedAt: 1,
    resalePlan: { ask: 45, attemptLimit: 6, stepDownPct: 0.08 } };
  assert.equal(nextResaleAttempt(purchase).price, 36);
  const discounted = { ...purchase, resalePlan: { ...purchase.resalePlan, ask: 36, openingAskRatio: 0.8 } };
  assert.equal(nextResaleAttempt(discounted).price, 36);
  assert.equal(nextResaleAttempt(discounted, [], { liquidResaleAskRatio: 0.6 }).price, 28);
  assert.equal(nextResaleAttempt({ ...purchase, accruedFees: 10 }, [], { listingFee: 2 }).price, 40);
  assert.equal(nextResaleAttempt({ ...purchase, lane: 'premium' }).price, 45);
  const failure = { auctionId: 'failed', userCardId: 'cheap', status: 'settled_unsold',
    price: 36, createdAt: 2, endAt: 3 };
  assert.equal(nextResaleAttempt(discounted, [failure]).price, 33);
});

test('a unique exact-variant return retains purchase cost and failures; ambiguous returns are not attributed', () => {
  const data = { purchases: { old: { userCardId: 'old', cardId: 'card', rarity: 'R', shiny: false,
    purchasePrice: 60, minProfit: 15, accruedFees: 4, status: 'inventory' } },
  listings: { failed: { auctionId: 'failed', userCardId: 'old', cardId: 'card', rarity: 'R',
    shiny: false, status: 'settled_unsold', price: 100 } },
  lastUnsoldByCopy: { old: { price: 100, endAt: 10 } }, seenOwnedIds: ['old'] };
  const row = { userCardId: 'new', cardId: 'card', rarity: 'R', shiny: false };
  assert.deepEqual(remapReturnedPurchases(structuredClone(data), [{ ...row, shiny: true }]), []);
  assert.deepEqual(remapReturnedPurchases(structuredClone(data), [row, { ...row, userCardId: 'new-2' }]), []);
  assert.equal(remapReturnedPurchases(data, [row]).length, 1);
  assert.equal(data.purchases.old, undefined);
  assert.equal(data.purchases.new.purchasePrice, 60);
  assert.equal(data.purchases.new.accruedFees, 4);
  assert.deepEqual(data.purchases.new.previousUserCardIds, ['old']);
  assert.equal(data.listings.failed.userCardId, 'new');
  assert.equal(data.lastUnsoldByCopy.new.price, 100);
});

test('external purchase attribution needs unique ownership, seller, variant and chronological evidence', () => {
  const purchase = { userCardId: 'bought', auctionId: 'buy', cardId: 'card', rarity: 'SR', shiny: false,
    purchasePrice: 13, status: 'inventory', purchasedAt: 1000 };
  const data = { purchases: { bought: purchase }, bids: { buy: { ownedBeforeIds: [] } },
    listings: { cancelled: { userCardId: 'bought', cardId: 'card', rarity: 'SR', shiny: false,
      status: 'cancelled', createdAt: 2000, settledAt: 3000, endAt: 10000 } } };
  const auction = { id: 'manual', seller_id: 'me', card_id: 'card', snapshot_rarity: 'SR', is_shiny: false,
    created_at: new Date(3100).toISOString(), end_at: new Date(5000).toISOString(),
    listing_base_amount: 20, status: 'settled_sold', final_price: 20 };
  const find = (d = data, rows = [auction], inventory = []) => findExternalPurchaseListings(d, inventory, rows, 'me');
  assert.equal(find().length, 1);
  assert.equal(find(data, [auction, auction]).length, 1);
  assert.equal(find(data, [{ ...auction, seller_id: 'other' }]).length, 0);
  assert.equal(find(data, [{ ...auction, is_shiny: true }]).length, 0);
  assert.equal(find(data, [{ ...auction, created_at: new Date(2500).toISOString() }]).length, 0);
  assert.equal(find(data, [{ ...auction, final_price: null }]).length, 0);
  assert.equal(find(data, [auction, { ...auction, id: 'another' }]).length, 0);
  assert.equal(find(data, [auction], [{ cardId: 'card', rarity: 'SR', shiny: false, userCardId: 'returned' }]).length, 0);
  assert.equal(find({ ...data, bids: {} }).length, 0);
  assert.equal(find({ ...data, bids: { buy: { ownedBeforeIds: ['duplicate'] } } }).length, 0);
  assert.equal(find({ ...data, purchases: { ...data.purchases, other: { ...purchase, userCardId: 'other' } } }).length, 0);
  assert.equal(find({ ...data, listings: { ...data.listings, other: { cardId: 'card', rarity: 'SR', shiny: false,
    userCardId: 'other', createdAt: 2100 } } }).length, 0);
  assert.equal(find(data, Array.from({ length: 201 }, (_, i) => ({ ...auction, id: `many-${i}` }))).length, 0);
});
