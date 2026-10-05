export const DURATION_EXPERIMENT = 'duration-10m-60m-v1';

export function chooseListingDuration(config, plannedMinutes, random = Math.random) {
  return config.premium?.listingDurationExperiment === true
    ? (random() < 0.5 ? 10 : 60) : plannedMinutes;
}

const bucket = (durationMinutes) => ({ durationMinutes, placed: 0, active: 0,
  sold: 0, unsold: 0, cancelled: 0, completed: 0, saleRate: null,
  revenue: 0, fees: 0, netProceeds: 0, slotHours: 0, netCoinsPerSlotHour: null,
  averageSalePrice: null, averageAsk: null, askTotal: 0,
  resaleProfit: 0, resaleProfitSales: 0 });

/** Only explicitly randomized live listings belong to the experiment. */
export function summarizeListingDurations(listings = {}, purchases = {}) {
  const groups = Object.fromEntries(['all', 'pack', 'purchase'].map((key) =>
    [key, [bucket(10), bucket(60)]]));
  let startedAt = null;
  const unique = new Map(Object.values(listings).map((row) => [row.auctionId, row]));
  for (const row of unique.values()) {
    if (row.durationExperiment !== DURATION_EXPERIMENT || ![10, 60].includes(row.durationMinutes)) continue;
    if (!['active', 'settled_sold', 'settled_unsold', 'cancelled'].includes(row.status)) continue;
    if (Number.isFinite(row.createdAt)) startedAt = Math.min(startedAt ?? row.createdAt, row.createdAt);
    const source = row.kind === 'purchase' ? 'purchase' : 'pack';
    for (const key of ['all', source]) {
      const result = groups[key].find((group) => group.durationMinutes === row.durationMinutes);
      result.placed++;
      result.askTotal += Number(row.price) || 0;
      if (row.status === 'active') { result.active++; continue; }
      result.completed++;
      if (row.status === 'settled_sold') {
        result.sold++;
        result.revenue += Number(row.finalPrice) || 0;
        const purchase = purchases[row.userCardId];
        if (purchase?.status === 'sold' && purchase.saleAuctionId === row.auctionId
          && Number.isFinite(purchase.realizedProfit)) {
          result.resaleProfit += purchase.realizedProfit;
          result.resaleProfitSales++;
        }
      } else if (row.status === 'settled_unsold') result.unsold++;
      else result.cancelled++;
      result.fees += Number(row.listingFee) || 0;
      // Include actual bidding extensions and early cancellation; exclude active
      // auctions so unfinished observations do not bias either duration arm.
      const finishedAt = row.status === 'cancelled' ? row.settledAt : row.endAt;
      if (Number.isFinite(finishedAt) && Number.isFinite(row.createdAt) && finishedAt > row.createdAt)
        result.slotHours += (finishedAt - row.createdAt) / 3_600_000;
    }
  }
  for (const rows of Object.values(groups)) for (const row of rows) {
    row.saleRate = row.sold + row.unsold ? row.sold / (row.sold + row.unsold) : null;
    row.averageSalePrice = row.sold ? row.revenue / row.sold : null;
    row.averageAsk = row.placed ? row.askTotal / row.placed : null;
    row.netProceeds = row.revenue - row.fees;
    row.netCoinsPerSlotHour = row.slotHours > 0 ? row.netProceeds / row.slotHours : null;
    delete row.askTotal;
  }
  return { experiment: DURATION_EXPERIMENT, startedAt, groups };
}
