import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const STATE_PATH = new URL('../state.json', import.meta.url);
export const EVENTS_PATH = new URL('../events.jsonl', import.meta.url);
export const PREMIUM_STATE_PATH = new URL('../state.premium.json', import.meta.url);
export const PREMIUM_EVENTS_PATH = new URL('../events.premium.jsonl', import.meta.url);
const PREMIUM_ARCHIVE_DIR = new URL('../archives/', import.meta.url);

const HISTORY_TYPES = {
  all: null,
  packs: new Set(['pack-opened', 'pack-blocked', 'pack-retry-requested']),
  listings: new Set(['listed', 'bid-observed', 'sold', 'unsold', 'cancelled', 'auction-result']),
  recycling: new Set(['recycled', 'recycle-retry', 'recycle-failed']),
  alerts: new Set(['balance-discrepancy', 'balance-reconciled', 'pack-blocked', 'recycle-failed',
    'human-verification', 'human-verification-cleared']),
  deals: new Set(),
  trades: new Set(['trade-offer-accepted', 'trade-offer-failed']),
};

/** Read the durable append-only journal with stable line-number pagination. */
export function readHistoryPage(file = EVENTS_PATH, { before = Infinity, limit = 50, category = 'all', query = '' } = {}) {
  if (!Object.hasOwn(HISTORY_TYPES, category)) throw new Error('invalid history category');
  let source = '';
  try { source = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = source.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const matches = [];
  const text = String(query).trim().toLowerCase();
  for (let index = 0; index < lines.length; index++) {
    let event;
    try { event = JSON.parse(lines[index]); } catch { continue; }
    if (!event || !Number.isFinite(event.at) || typeof event.type !== 'string') continue;
    if (category === 'deals' && !event.type.startsWith('deal-') && event.type !== 'resale-profit') continue;
    if (category !== 'deals' && HISTORY_TYPES[category] && !HISTORY_TYPES[category].has(event.type)) continue;
    if (text && !JSON.stringify(event).toLowerCase().includes(text)) continue;
    matches.push({ index, ...event });
  }
  const eligible = matches.filter((event) => event.index < before);
  const rows = eligible.slice(-limit).reverse();
  return { rows, total: matches.length, nextBefore: eligible.length > limit ? rows.at(-1).index : null };
}

const SNIPE_EVENTS = new Set(['deal-planned', 'deal-snipe-skipped', 'deal-snipe-failed',
  'deal-bid-failed', 'deal-bid-uncertain', 'deal-bid-unconfirmed', 'deal-bid',
  'deal-refund-observed', 'deal-dry-bid', 'deal-dry-outcome', 'deal-won', 'deal-lost']);

/** Group the durable premium deal journal by auction, newest activity first. */
export function readSnipeHistoryPage(file = PREMIUM_EVENTS_PATH, {
  before = Infinity, limit = 25, activePlanIds = [], now = Date.now(),
} = {}) {
  let source = '';
  try { source = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const groups = new Map();
  const engineStarts = [];
  source.split('\n').forEach((line, index) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'deal-engine-started' && Number.isFinite(event.at)) {
      engineStarts.push(event.at);
      return;
    }
    if (!event || !SNIPE_EVENTS.has(event.type) || !event.auctionId || !Number.isFinite(event.at)) return;
    const id = String(event.auctionId);
    let row = groups.get(id);
    if (!row) {
      row = { auctionId: id, cardId: null, title: null, rarity: null, shiny: null,
        amount: null, plannedAmount: null, requiredBid: null, maxBid: null,
        currentPrice: null, fireAt: null, endAt: null,
        at: event.at, latestType: null, reason: null,
        finalPrice: null, estimatedWouldWin: null, lastIndex: index, events: [] };
      groups.set(id, row);
    }
    row.cardId = event.cardId ?? row.cardId;
    row.title = event.title ?? row.title;
    row.rarity = event.rarity ?? row.rarity;
    row.shiny = event.shiny ?? row.shiny;
    row.amount = event.amount ?? event.proposedAmount ?? row.amount;
    if (event.type === 'deal-planned') row.plannedAmount = event.amount ?? row.plannedAmount;
    row.requiredBid = event.requiredBid ?? null;
    row.maxBid = event.maxBid ?? row.maxBid;
    row.currentPrice = event.currentPrice ?? null;
    row.fireAt = event.fireAt ?? row.fireAt;
    row.endAt = event.endAt ?? row.endAt;
    row.at = event.at;
    row.latestType = event.type;
    row.lastIndex = index;
    row.reason = event.reason == null ? null : String(event.reason);
    if (event.finalPrice != null || event.price != null) row.finalPrice = event.finalPrice ?? event.price;
    if (event.estimatedWouldWin != null) row.estimatedWouldWin = Boolean(event.estimatedWouldWin);
    row.events.push({ at: event.at, type: event.type, amount: event.amount ?? event.proposedAmount ?? null,
      requiredBid: event.requiredBid ?? null, maxBid: event.maxBid ?? null,
      currentPrice: event.currentPrice ?? null,
      reason: event.reason ?? null, status: event.status ?? null,
      finalPrice: event.finalPrice ?? event.price ?? null });
  });
  const active = new Set(activePlanIds.map(String));
  const rows = [...groups.values()].sort((a, b) => b.lastIndex - a.lastIndex).map((row) => {
    if (row.latestType === 'deal-planned' && !active.has(row.auctionId)) {
      row.latestType = 'deal-plan-unresolved';
      const restartedBeforeFire = row.fireAt != null && engineStarts.some((at) => at > row.at && at < row.fireAt);
      row.reason = restartedBeforeFire
        ? 'Bot restarted before the planned bid; this in-memory plan was interrupted.'
        : row.fireAt != null && row.fireAt > now
        ? 'Plan is no longer queued before its bid time. No cancellation reason was saved.'
        : 'Only the plan was saved. No bid, skip, or failure outcome was logged; the exact cause is unknown.';
    }
    return row;
  });
  const eligible = rows.filter((row) => row.lastIndex < before);
  return { rows: eligible.slice(0, limit), total: rows.length,
    nextBefore: eligible.length > limit ? eligible[limit - 1].lastIndex : null };
}

const fresh = () => ({
  version: 1,
  startedAt: Date.now(),
  accountId: null,
  startBalance: null,
  lastBalance: null,
  lastReportedDelta: 0,
  paused: false,
  baselineSeen: false,
  seenOwnedIds: [],
  arrivals: [],
  slotSamples: [],
  listings: {},
  lastUnsoldByCopy: {},
  bids: {},
  purchases: {},
  premiumCopies: {},
  dealsCursor: null,
  tradeOffers: { acceptedCount: 0, lastCheckedAt: null, lastAcceptedAt: null,
    pending: [], recentAccepted: [], lastError: null },
  humanVerification: null,
  stats: { opened: 0, recycled: 0, recycleRevenue: 0, listed: 0, listingFees: 0,
    sold: 0, salesRevenue: 0, unsold: 0 },
});

/** The state file is a checkpoint, while the JSONL file is the human-readable action journal. */
export class StateStore {
  constructor({ file = STATE_PATH, eventFile = EVENTS_PATH, account = 'standard',
    archiveDirectory = PREMIUM_ARCHIVE_DIR } = {}) {
    this.file = file;
    this.eventFile = eventFile;
    this.account = account;
    this.archiveDirectory = archiveDirectory;
    try {
      this.data = { ...fresh(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      if (e.code !== 'ENOENT' && file) throw e;
      this.data = fresh();
    }
    this.data.stats = { ...fresh().stats, ...this.data.stats };
    this.data.listings ??= {};
    this.data.lastUnsoldByCopy ??= {};
    this.data.arrivals ??= [];
    this.data.slotSamples ??= [];
    this.data.seenOwnedIds ??= [];
    this.events = [];
    try {
      const lines = fs.readFileSync(eventFile, 'utf8').trim().split('\n').slice(-100);
      this.events = lines.map((line) => JSON.parse(line)).filter(Boolean);
    } catch {}
  }

  save() {
    if (!this.file) return;
    const tmp = typeof this.file === 'string'
      ? `${this.file}.tmp`
      : new URL(`${this.file.pathname.split('/').at(-1)}.tmp`, this.file);
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  record(type, data = {}) {
    const event = { at: Date.now(), type, ...data };
    this.events.push(event);
    if (this.events.length > 100) this.events.shift();
    if (this.eventFile) fs.appendFileSync(this.eventFile, JSON.stringify(event) + '\n');
    return event;
  }

  /** Preserve a premium account's checkpoint and journal before an explicit account switch. */
  archiveAndReset({ label = 'previous-account' } = {}) {
    if (this.account !== 'premium')
      throw new Error('account switching is only supported for the premium account');
    fs.mkdirSync(this.archiveDirectory, { recursive: true });
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'previous-account';
    const key = `${Date.now()}-${safeLabel}-${randomUUID().slice(0, 8)}`;
    const base = path.join(filePath(this.archiveDirectory), key);
    fs.writeFileSync(`${base}.state.json`, JSON.stringify(this.data));
    try { fs.renameSync(filePath(this.eventFile), `${base}.events.jsonl`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.data = fresh();
    this.events = [];
    this.save();
    fs.writeFileSync(filePath(this.eventFile), '');
    return { key, archivedAt: Date.now(), label: safeLabel };
  }
}

function filePath(file) { return file instanceof URL ? fileURLToPath(file) : file; }

export function listPremiumArchives() {
  let names = [];
  try { names = fs.readdirSync(filePath(PREMIUM_ARCHIVE_DIR)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return names.filter((name) => name.endsWith('.state.json')).map((name) => {
    const key = name.slice(0, -'.state.json'.length);
    const at = Number(key.split('-')[0]);
    return { key, at: Number.isFinite(at) ? at : null,
      label: key.split('-').slice(1, -1).join('-') || 'Previous premium account' };
  }).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export function readPremiumArchiveHistory(key, options = {}) {
  if (typeof key !== 'string' || !/^\d+-[a-zA-Z0-9_-]+-[a-f0-9]{8}$/.test(key))
    throw new Error('invalid premium archive');
  const archive = listPremiumArchives().find((item) => item.key === key);
  if (!archive) throw new Error('premium archive not found');
  return readHistoryPage(path.join(filePath(PREMIUM_ARCHIVE_DIR), `${key}.events.jsonl`), options);
}
