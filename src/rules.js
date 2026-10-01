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

/**
 * Lowest bid the site accepts on top of `current`: 10% more, rounded up, and at least +1.
 * (Same rule as the site's own page; integer maths so 20 -> 22, not 23.)
 */
export const minNextBid = (current) => Math.max(Math.ceil((current * 11) / 10), current + 1);

const nextAmount = (a, inc) => (a.current_bid == null ? a.base_amount : Math.max(a.current_bid + inc, minNextBid(a.current_bid)));

/**
 * Returns { action: 'bid', rule, amount, max, counters, target?, priority?, theme? } or { action: 'skip', reason }.
 * A card on the target list (`targets`: card id -> target) is decided by its target: its own max bid, priority and
 * theme. Everything else goes through the bid rules, first matching rule wins.
 */
export function decide(cfg, a, myUserId, wishlist = new Set(), targets = new Map()) {
  if (a.status !== 'active') return { action: 'skip', reason: 'not active' };
  if (a.seller_id === myUserId) return { action: 'skip', reason: 'own listing' };
  if (a.current_bidder_id === myUserId) return { action: 'skip', reason: 'already leading' };
  if (cfg.global.skipOwned && a.owned) return { action: 'skip', reason: 'already owned' };

  const t = targets.get(a.card_id);
  if (t) {
    const name = `target${t.theme ? ':' + t.theme : ''}`;
    const amount = nextAmount(a, cfg.targets?.increment ?? 1);
    if (amount > t.maxBid) return { action: 'skip', reason: `${name}: ${amount} > max ${t.maxBid}` };
    return { action: 'bid', rule: name, amount, max: t.maxBid, counters: t.counters ?? cfg.targets?.counters, target: true, priority: t.priority, theme: t.theme ?? null };
  }

  const f = auctionFacts(a);
  for (const rule of cfg.rules) {
    if (rule.enabled === false || !matches(rule.when, f, wishlist)) continue;
    if (rule.skip) return { action: 'skip', reason: `rule ${rule.name}` };
    const amount = nextAmount(a, rule.bid?.increment ?? 1);
    if (amount > (rule.bid?.max ?? 0)) return { action: 'skip', reason: `rule ${rule.name}: ${amount} > max ${rule.bid?.max}` };
    return { action: 'bid', rule: rule.name, amount, max: rule.bid?.max ?? 0, counters: rule.bid?.counters };
  }
  return { action: 'skip', reason: 'no rule matched' };
}

/**
 * Name of the first enabled bid rule whose card conditions this owned card meets, else null. Such cards are
 * ones the bot would bid on, so it never sells or recycles them. Price conditions are ignored (an owned card has
 * no auction price), and a rule left with no other condition is ignored so it cannot protect everything.
 */
export function bidRuleMatch(cfg, facts, wishlist = new Set()) {
  for (const rule of cfg.rules) {
    if (rule.enabled === false || rule.skip) continue;
    const { minPrice, maxCurrentPrice, ...when } = rule.when ?? {};
    if (!Object.keys(when).length) continue;
    if (matches(when, facts, wishlist)) return rule.name;
  }
  return null;
}

/** Returns { action: 'recycle' | 'keep', rule }. First matching rule wins, otherwise recycle.default. */
export function decideRecycle(rcfg, facts, wishlist = new Set()) {
  for (const rule of rcfg.rules) {
    if (rule.enabled === false || !matches(rule.when, facts, wishlist)) continue;
    return { action: rule.action, rule: rule.name };
  }
  return { action: rcfg.default, rule: 'default' };
}

/** Returns { action: 'sell' | 'keep', rule, ruleObj }. First matching rule wins, otherwise sell.default. */
export function decideSell(scfg, facts, wishlist = new Set()) {
  for (const rule of scfg.rules) {
    if (rule.enabled === false || !matches(rule.when, facts, wishlist)) continue;
    return { action: rule.action, rule: rule.name, ruleObj: rule };
  }
  return { action: scfg.default, rule: 'default', ruleObj: null };
}

export const describe = (a) =>
  `${a.card?.wikipedia_title ?? '?'} [${a.snapshot_rarity}${a.is_shiny ? '★' : ''}] pv=${a.card?.pageviews} atk=${a.snapshot_atk}/${a.snapshot_def} price=${price(a)}`;
