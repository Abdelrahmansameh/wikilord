/**
 * Keep one bid plan per card. Prefer the auction that ends SOONEST (you only need one copy, so take the first
 * real chance; if it is lost, the next listing gets planned on a later scan), unless a later listing is clearly
 * cheaper: at least 25% and 5 coins less. That avoids paying 150 now when the same card goes for 33 later,
 * without dropping a snipe ending in 45 minutes to save 1 coin hours later.
 * Ties: lower bid, then auction id, so the choice is stable.
 */
const clearlyCheaper = (later, sooner) => later <= sooner * 0.75 && sooner - later >= 5;

export function cheapestPerCard(candidates) {
  const byCard = new Map();
  for (const c of candidates) {
    const key = c.auction.card_id ?? c.auction.id;
    if (!byCard.has(key)) byCard.set(key, []);
    byCard.get(key).push(c);
  }
  const chosen = [];
  for (const list of byCard.values()) {
    list.sort((x, y) => Date.parse(x.auction.end_at) - Date.parse(y.auction.end_at)
      || x.decision.amount - y.decision.amount
      || (x.auction.id < y.auction.id ? -1 : 1));
    let pick = list[0];
    for (const c of list.slice(1)) if (clearlyCheaper(c.decision.amount, pick.decision.amount)) pick = c;
    chosen.push(pick);
  }
  return chosen;
}
