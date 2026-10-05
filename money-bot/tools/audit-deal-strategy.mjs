// Read-only comparison of acquisition rules using watched auctions and exact
// settled history. Never starts a bot or sends requests to the game.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { quoteHybridResale } from '../src/model.js';
import { Session, PREMIUM_SESSION_FILE, PREMIUM_ENV_FILE } from '../src/session.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseUrl = process.argv.find((arg) => arg.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:8789';
const limit = Number(process.argv.find((arg) => arg.startsWith('--limit='))?.slice(8) ?? 2000);
if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit must be 1 to 10000');
const read = async (name, premium = true) => {
  const response = await fetch(`${baseUrl}/api/${premium ? 'premium/' : ''}${name}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
};
const [settings, deals, state] = await Promise.all([
  read('settings'), read('deals'), read('state'),
]);
const config = settings.config;
const checkpoint = JSON.parse(fs.readFileSync(path.join(root, 'state.premium.json'), 'utf8'));
// Reading identities does not initialize, renew, or make requests with sessions.
const controlledUserIds = [...new Set([
  new Session({ allowRenewal: false }).userId(),
  new Session({ allowRenewal: false, sessionFile: PREMIUM_SESSION_FILE, envFile: PREMIUM_ENV_FILE }).userId(),
].filter(Boolean))];
const options = { buy: config.buy, premiumThreshold: { ...config.premium, minSold: config.buy.minSold },
  listingFee: config.listingFee, cutoff: state.cutoff?.value ?? 0, slots: state.slots,
  queueDepth: (state.decisions ?? []).filter((row) => row.action === 'queue').length,
  durationMinutes: config.listing.durationMinutes, controlledUserIds,
  ownOutcomes: Object.entries(checkpoint.listings ?? {}).map(([id, item]) => ({ ...item, auctionId: id })),
  now: Date.now() };
const calibration = { shift: state.modelHealth?.premiumCalibration?.shift ?? 0,
  dataTimestamp: state.modelHealth?.dataTimestamp };
const db = new DatabaseSync(process.env.WM_MARKET_DB ?? path.resolve(root, config.marketDb), { readOnly: true });
const query = db.prepare(`SELECT id, card_id, seller_id, winner_id, rarity, is_shiny,
  listing_base_amount, base_repriced_at, status, final_price, end_at, created_at
  FROM auctions INDEXED BY auctions_card WHERE final = 1
  AND status IN ('settled_sold', 'settled_unsold') AND card_id = ? AND rarity = ? AND is_shiny = ?
  AND end_at >= ? AND end_at <= ?`);
const profiles = {
  current: {},
  margins: { premiumMinProfit: 100, liquidMinProfit: 30, liquidMinRoi: 0.4 },
  turnover: { premiumMinProfit: 100, liquidMinProfit: 30, liquidMinRoi: 0.4,
    horizonProbability: 0.8, minAttemptProbability: 0.5 },
  balanced: { premiumMinProfit: 100, liquidMinProfit: 30, liquidMinRoi: 0.4,
    horizonProbability: 0.8, minAttemptProbability: 0.5,
    minProfitPerSlotHour: 30, slotOpportunityCoinsPerHour: 15 },
  balanced85: { premiumMinProfit: 100, liquidMinProfit: 30, liquidMinRoi: 0.4,
    horizonProbability: 0.85, minAttemptProbability: 0.6,
    minProfitPerSlotHour: 30, slotOpportunityCoinsPerHour: 15 },
};
const results = Object.fromEntries(Object.keys(profiles).map((name) => [name, { quoted: 0, qualified: 0,
  nearEnd: 0, lanes: {}, rejections: {}, examples: [] }]));
const cache = new Map();
const candidates = deals.candidates.filter((row) => row.endAt > options.now).slice(0, limit);
try {
  for (const row of candidates) {
    const facts = { cardId: row.cardId, rarity: row.rarity, shiny: row.shiny };
    const key = `${row.cardId}|${row.rarity}|${Number(Boolean(row.shiny))}`;
    let history = cache.get(key);
    if (!history) { history = query.all(row.cardId, row.rarity, Number(Boolean(row.shiny)),
      options.now - 14 * 86400000, options.now); cache.set(key, history); }
    for (const [name, changes] of Object.entries(profiles)) {
      const summary = results[name]; summary.quoted++;
      const quote = quoteHybridResale(history, facts, { ...options, buy: { ...config.buy, ...changes } }, calibration);
      const amount = row.amount ?? row.price;
      const reason = quote.reason ?? (amount > quote.maxBid ? 'price above ceiling' : null);
      if (reason) { summary.rejections[reason] = (summary.rejections[reason] ?? 0) + 1; continue; }
      summary.qualified++;
      summary.lanes[quote.lane] = (summary.lanes[quote.lane] ?? 0) + 1;
      if (row.endAt - options.now <= config.buy.planningHorizonMinutes * 60000) summary.nearEnd++;
      const netProfit = quote.stressedValue - quote.expectedFees - quote.slotCost - amount;
      summary.examples.push({ title: row.title, lane: quote.lane, amount, maxBid: quote.maxBid,
        ask: quote.safeExit, probability: +quote.horizonP.toFixed(3),
        firstAttempt: +quote.chosen.riskAdjustedP.toFixed(3),
        netProfit: Math.floor(netProfit), coinsPerHour: Math.floor(netProfit / quote.expectedSlotHours),
        hours: +quote.expectedSlotHours.toFixed(2) });
    }
  }
  for (const summary of Object.values(results)) {
    summary.examples.sort((a, b) => b.coinsPerHour - a.coinsPerHour);
    summary.examples = summary.examples.slice(0, 10);
  }
  console.log(JSON.stringify({ sampledAt: new Date(options.now).toISOString(),
    sampleSize: candidates.length, exactVariants: cache.size, queueDepth: options.queueDepth,
    calibrationShift: calibration.shift, controlledAccounts: controlledUserIds.length,
    scope: 'Economic comparison at observed prices; excludes live refresh, cash, capacity and owned-variant checks. Forecasts are not realized profit.',
    profiles, results }, null, 2));
} finally { db.close(); }
