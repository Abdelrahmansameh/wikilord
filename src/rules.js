const price = (a) => a.effective_bid ?? a.current_bid ?? a.base_amount;

/** Lower-case and strip accents so "mathématiques" matches "Mathematiques". */
export const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Normalised facts about an auction, used by the shared matcher. */
export const auctionFacts = (a) => ({
  cardId: a.card_id,
  rarity: a.snapshot_rarity ?? a.card?.rarity,
  shiny: Boolean(a.is_shiny),
  starred: false,
  tagged: false,
  pageviews: a.card?.pageviews ?? 0,
  qScore: Number(a.card?.q_score ?? 0),
  atk: a.snapshot_atk ?? a.card?.atk ?? 0,
  def: a.snapshot_def ?? a.card?.def ?? 0,
  title: a.card?.wikipedia_title ?? '',
  category: a.card?.category ?? '',
  price: price(a),
});

/** Normalised facts about a card you own (collection entry or freshly opened pack card). */
export const ownedFacts = ({ card, cardId, shiny, starred, tagged }) => ({
  cardId,
  rarity: card.rarity,
  shiny: Boolean(shiny),
  starred: Boolean(starred),
  tagged: Boolean(tagged),
  pageviews: card.pageviews ?? 0,
  qScore: Number(card.q_score ?? 0),
  atk: card.atk ?? 0,
  def: card.def ?? 0,
  title: card.wikipedia_title ?? '',
  category: card.category ?? '',
  price: 0,
});

/** True when every condition in `when` holds. An empty/missing `when` matches everything. */
export function matches(when = {}, f, wishlist = new Set()) {
  if (when.wishlist !== undefined && wishlist.has(f.cardId) !== when.wishlist) return false;
  if (when.rarity && !when.rarity.map((r) => r.toUpperCase()).includes(String(f.rarity).toUpperCase())) return false;
  for (const k of ['shiny', 'starred', 'tagged']) if (when[k] !== undefined && f[k] !== when[k]) return false;
  if (when.minPageviews !== undefined && f.pageviews < when.minPageviews) return false;
  if (when.maxPageviews !== undefined && f.pageviews > when.maxPageviews) return false;
  if (when.minQScore !== undefined && f.qScore < when.minQScore) return false;
  if (when.maxQScore !== undefined && f.qScore > when.maxQScore) return false;
  if (when.minAtk !== undefined && f.atk < when.minAtk) return false;
  if (when.maxAtk !== undefined && f.atk > when.maxAtk) return false;
  if (when.minDef !== undefined && f.def < when.minDef) return false;
  if (when.maxDef !== undefined && f.def > when.maxDef) return false;
  if (when.minPrice !== undefined && f.price < when.minPrice) return false;
  if (when.maxCurrentPrice !== undefined && f.price > when.maxCurrentPrice) return false;
  if (when.titleContains && !plain(f.title).includes(plain(when.titleContains))) return false;
  if (when.titleRegex && !new RegExp(when.titleRegex, 'i').test(f.title)) return false;
  if (when.categoryRegex && !new RegExp(when.categoryRegex, 'i').test(f.category)) return false;
  return true;
}

/** Returns { action: 'bid', rule, amount } or { action: 'skip', reason }. First matching rule wins. */
export function decide(cfg, a, myUserId, wishlist = new Set()) {
  if (a.status !== 'active') return { action: 'skip', reason: 'not active' };
  if (a.seller_id === myUserId) return { action: 'skip', reason: 'own listing' };
  if (a.current_bidder_id === myUserId) return { action: 'skip', reason: 'already leading' };
  if (cfg.global.skipOwned && a.owned) return { action: 'skip', reason: 'already owned' };

  const f = auctionFacts(a);
  for (const rule of cfg.rules) {
    if (rule.enabled === false || !matches(rule.when, f, wishlist)) continue;
    if (rule.skip) return { action: 'skip', reason: `rule ${rule.name}` };
    const inc = rule.bid?.increment ?? 1;
    const amount = a.current_bid == null ? a.base_amount : a.current_bid + inc;
    if (amount > (rule.bid?.max ?? 0)) return { action: 'skip', reason: `rule ${rule.name}: ${amount} > max ${rule.bid?.max}` };
    return { action: 'bid', rule: rule.name, amount };
  }
  return { action: 'skip', reason: 'no rule matched' };
}

/** Returns { action: 'recycle' | 'keep', rule }. First matching rule wins, otherwise recycle.default. */
export function decideRecycle(rcfg, facts, wishlist = new Set()) {
  for (const rule of rcfg.rules) {
    if (rule.enabled === false || !matches(rule.when, facts, wishlist)) continue;
    return { action: rule.action, rule: rule.name };
  }
  return { action: rcfg.default, rule: 'default' };
}

export const describe = (a) =>
  `${a.card?.wikipedia_title ?? '?'} [${a.snapshot_rarity}${a.is_shiny ? '★' : ''}] pv=${a.card?.pageviews} atk=${a.snapshot_atk}/${a.snapshot_def} price=${price(a)}`;
