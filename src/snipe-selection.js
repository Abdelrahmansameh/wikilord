/** Keep the auction with the lowest bid needed for each card. */
export function cheapestPerCard(candidates) {
  const best = new Map();
  for (const candidate of candidates) {
    const { auction, decision } = candidate;
    const key = auction.card_id ?? auction.id;
    const previous = best.get(key);
    if (!previous
      || decision.amount < previous.decision.amount
      || (decision.amount === previous.decision.amount && Date.parse(auction.end_at) < Date.parse(previous.auction.end_at))
      || (decision.amount === previous.decision.amount && auction.end_at === previous.auction.end_at && auction.id < previous.auction.id)) {
      best.set(key, candidate);
    }
  }
  return [...best.values()];
}
