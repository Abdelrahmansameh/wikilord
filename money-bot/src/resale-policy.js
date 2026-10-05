const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Beta-binomial survival permits persistent demand differences between cards.
 * A failed first auction updates latent demand, so retries are not treated as
 * independent guaranteed second chances. This is an estimate, not a guarantee.
 */
export function resaleHorizon(probability, attempts, correlation = 0.5) {
  const p = clamp(Number(probability) || 0, 0, 1);
  const count = clamp(Math.floor(Number(attempts) || 1), 1, 24);
  const rho = clamp(Number(correlation) || 0, 0, 1);
  let survival = 1, expectedAttempts = 0;
  const saleProbabilities = [];
  const concentration = rho > 0 && rho < 1 ? 1 / rho - 1 : null;
  for (let i = 0; i < count; i++) {
    expectedAttempts += survival;
    const failureChance = rho === 1 ? (i === 0 ? 1 - p : 1)
      : rho === 0 ? 1 - p
        : ((1 - p) * concentration + i) / (concentration + i);
    saleProbabilities.push(survival * (1 - failureChance));
    survival *= failureChance;
  }
  return { probability: clamp(1 - survival, 0, 1), expectedAttempts, survival, saleProbabilities };
}

export function resaleProfitFloor(purchase, { listingFee = 0, fallbackProfit = 200 } = {}) {
  if (!purchase || !Number.isFinite(Number(purchase.purchasePrice))) return null;
  const cost = Number(purchase.purchasePrice);
  const margin = Math.max(Number(purchase.minProfit ?? fallbackProfit),
    Math.ceil(cost * Number(purchase.minRoi ?? 0)));
  return Math.ceil(cost + margin + Number(purchase.accruedFees ?? 0) + Number(listingFee));
}

/** Retries use the acquisition's recorded exit plan, while preserving its profit floor. */
export function nextResaleAttempt(purchase, outcomes = [], options = {}) {
  const plan = purchase?.resalePlan;
  if (!plan || !Number.isFinite(Number(plan.ask)) || Number(plan.ask) < 1) return null;
  const copyIds = new Set([purchase.userCardId, ...(purchase.previousUserCardIds ?? [])].filter(Boolean));
  const failures = outcomes.filter((item) => item.status === 'settled_unsold'
    && copyIds.has(item.userCardId) && Number(item.createdAt ?? 0) >= Number(purchase.wonAt ?? purchase.purchasedAt ?? 0));
  const uniqueFailures = [...new Map(failures.map((item) => [item.auctionId ?? item.id, item])).values()];
  const failureCount = uniqueFailures.length;
  const attemptLimit = Math.max(1, Math.floor(Number(plan.attemptLimit) || 6));
  const floor = resaleProfitFloor(purchase, options);
  if (failureCount >= attemptLimit) return { exhausted: true, failureCount, attemptLimit, floor,
    reason: 'resale attempt budget used; retaining the card above its profit floor' };
  const stepDown = clamp(Number(plan.stepDownPct ?? 0.08), 0, 0.5);
  // Recorded asks already include their acquisition-time discount. Adjust by
  // the ratio change only; legacy plans have no discount recorded.
  const ratio = purchase.lane === 'liquid' ? Number(options.liquidResaleAskRatio ?? 0.8) : 1;
  const recordedRatio = purchase.lane === 'liquid' ? Number(plan.openingAskRatio ?? 1) : 1;
  const openingAsk = Number(plan.ask) * ratio / recordedRatio;
  let price = Math.max(floor, Math.floor(openingAsk * (1 - stepDown) ** failureCount));
  if (uniqueFailures.length) {
    const latest = uniqueFailures.sort((a, b) => Number(b.endAt ?? b.settledAt) - Number(a.endAt ?? a.settledAt))[0];
    price = Math.max(floor, Math.min(price, Math.floor(Number(latest.price) * (1 - stepDown))));
  }
  return { price, floor, failureCount, attemptLimit, exhausted: false,
    durationMinutes: Number(plan.durationMinutes) || 60 };
}

/**
 * Some returned unsold cards receive a new copy ID. Link only one missing copy
 * to one previously unseen exact-variant return; ambiguous duplicates stay held.
 */
export function remapReturnedPurchases(data, inventory) {
  const variant = (row) => `${row.cardId}|${row.rarity}|${Number(Boolean(row.shiny))}`;
  const current = new Set(inventory.map((row) => row.userCardId));
  const seen = new Set(data.seenOwnedIds ?? []);
  const missing = new Map(), returns = new Map();
  for (const [copyId, purchase] of Object.entries(data.purchases ?? {})) {
    if (current.has(copyId) || purchase.status === 'sold' || purchase.status === 'recycled') continue;
    if (!Object.values(data.listings ?? {}).some((item) => item.userCardId === copyId
      && ['settled_unsold', 'cancelled'].includes(item.status))) continue;
    if (Object.values(data.listings ?? {}).some((item) => item.userCardId === copyId && item.status === 'active')) continue;
    const key = variant(purchase);
    if (!missing.has(key)) missing.set(key, []);
    missing.get(key).push({ copyId, purchase });
  }
  for (const row of inventory) {
    if (data.purchases?.[row.userCardId] || seen.has(row.userCardId)) continue;
    const key = variant(row);
    if (!returns.has(key)) returns.set(key, []);
    returns.get(key).push(row);
  }
  const remapped = [];
  for (const [key, old] of missing) {
    const fresh = returns.get(key) ?? [];
    if (old.length !== 1 || fresh.length !== 1) continue;
    const { copyId, purchase } = old[0], nextId = fresh[0].userCardId;
    purchase.previousUserCardIds = [...new Set([...(purchase.previousUserCardIds ?? []), copyId])];
    purchase.userCardId = nextId;
    data.purchases[nextId] = purchase;
    delete data.purchases[copyId];
    if (data.lastUnsoldByCopy?.[copyId]) {
      data.lastUnsoldByCopy[nextId] = data.lastUnsoldByCopy[copyId];
      delete data.lastUnsoldByCopy[copyId];
    }
    // Keep auction IDs and forecasts intact, but attach their accounting to the
    // returned copy so every paid fee and eventual sale retains its cost basis.
    for (const item of Object.values(data.listings ?? {})) if (item.userCardId === copyId) {
      item.previousUserCardId ??= copyId;
      item.userCardId = nextId;
    }
    remapped.push({ previousUserCardId: copyId, userCardId: nextId, cardId: purchase.cardId });
  }
  return remapped;
}

/** Recover listings made outside the bot only when the missing purchase has a
 * unique exact-variant match. A missing copy alone never proves a sale. */
export function findExternalPurchaseListings(data, inventory, auctions, sellerId) {
  if (!sellerId) return [];
  const variant = (row) => `${row.cardId ?? row.card_id}|${row.rarity ?? row.snapshot_rarity ?? row.card?.rarity}|${Number(Boolean(row.shiny ?? row.is_shiny))}`;
  const time = (value) => typeof value === 'number' ? value : Date.parse(value);
  const purchases = Object.values(data.purchases ?? {}).filter((p) => !['sold', 'recycled'].includes(p.status));
  const uniqueAuctions = [...new Map(auctions.map((a) => [a.id, a])).values()];
  const matches = [];
  for (const purchase of purchases) {
    const key = variant(purchase), acquiredAt = Number(purchase.purchasedAt ?? purchase.wonAt);
    if (!Number.isFinite(acquiredAt) || inventory.some((row) => variant(row) === key)) continue;
    if (purchases.filter((p) => variant(p) === key).length !== 1) continue;
    // Without the site's copy ID, pre-existing duplicates would make ownership
    // ambiguous. Require the acquisition's fresh ownership snapshot as evidence.
    const before = data.bids?.[purchase.auctionId]?.ownedBeforeIds;
    if (!Array.isArray(before) || before.length) continue;
    const known = Object.values(data.listings ?? {}).filter((a) => a.userCardId === purchase.userCardId);
    if (known.some((a) => a.status === 'active')) continue;
    // Another known copy listed after acquisition is also ambiguous.
    if (Object.values(data.listings ?? {}).some((a) => variant(a) === key
      && a.userCardId !== purchase.userCardId && Number(a.createdAt) >= acquiredAt)) continue;
    const after = Math.max(acquiredAt, ...known.map((a) => Number(a.settledAt ?? a.endAt ?? a.createdAt) || acquiredAt));
    const rows = uniqueAuctions.filter((a) => a.seller_id === sellerId && variant(a) === key
      && time(a.created_at) >= acquiredAt);
    if (rows.length > 200) continue; // The bounded history query may be truncated.
    const candidates = rows.filter((a) => !data.listings?.[a.id] && time(a.created_at) >= after
      && ['active', 'settled_sold', 'settled_unsold', 'cancelled'].includes(a.status)
      && Number.isFinite(time(a.end_at)) && Number(a.listing_base_amount ?? a.base_amount) > 0);
    if (candidates.length !== 1) continue;
    const auction = candidates[0];
    if (auction.status === 'settled_sold' && !(Number(auction.final_price) > 0)) continue;
    matches.push({ purchase, auction });
  }
  return matches;
}
