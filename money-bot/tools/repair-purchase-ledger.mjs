import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const variant = (item) => `${item.cardId}|${item.rarity}|${Number(Boolean(item.shiny))}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Require a fully evidenced, unique acquisition-to-resale copy chain. */
export function proposePurchaseLedgerRepairs(data, events, { controlledUserIds = [] } = {}) {
  const repairs = [], rejected = [];
  const ownIds = new Set([data.accountId, ...controlledUserIds].filter(Boolean));
  const eventAt = (event) => Number(event.at ?? 0);
  const reject = (purchase, reason) => rejected.push({ auctionId: purchase.auctionId,
    cardId: purchase.cardId, userCardId: purchase.userCardId, reason });
  for (const [copyId, purchase] of Object.entries(data.purchases ?? {})) {
    if (purchase.status === 'sold' || purchase.status === 'recycled') continue;
    const key = variant(purchase);
    const samePurchases = Object.values(data.purchases ?? {}).filter((item) => variant(item) === key);
    const wins = Object.values(data.bids ?? {}).filter((item) => variant(item) === key && item.status === 'won');
    const bid = wins[0];
    if (samePurchases.length !== 1 || wins.length !== 1 || bid.auctionId !== purchase.auctionId
      || bid.userCardId !== copyId || purchase.userCardId !== copyId)
      { reject(purchase, 'paid acquisition or original copy attribution is not unique'); continue; }
    if (!Array.isArray(bid.ownedBeforeIds) || bid.ownedBeforeIds.length !== 0)
      { reject(purchase, 'pre-acquisition exact-variant inventory was not explicitly empty'); continue; }
    const price = Number(purchase.purchasePrice), purchasedAt = Number(purchase.purchasedAt);
    if (!Number.isSafeInteger(price) || price <= 0 || !Number.isFinite(purchasedAt) || purchasedAt <= 0
      || Number(bid.purchasePrice ?? bid.amount) !== price)
      { reject(purchase, 'paid purchase cost or timestamp is not verified'); continue; }
    if (!events.some((event) => event.type === 'deal-won' && event.auctionId === purchase.auctionId
      && event.cardId === purchase.cardId && Number(event.price) === price)
      || !events.some((event) => event.type === 'deal-purchase-matched' && event.auctionId === purchase.auctionId
        && event.cardId === purchase.cardId && event.userCardId === copyId && Number(event.price) === price))
      { reject(purchase, 'acquisition journal does not confirm payment and copy matching'); continue; }
    const chain = Object.values(data.listings ?? {}).filter((item) => variant(item) === key
      && Number(item.createdAt) >= purchasedAt).sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
    if (chain.length < 2 || chain[0].userCardId !== copyId
      || chain.at(-1).status !== 'settled_sold'
      || chain.slice(0, -1).some((item) => item.status !== 'settled_unsold')
      || new Set(chain.map((item) => item.userCardId)).size !== chain.length)
      { reject(purchase, 'no unique unsold-remint chain terminating in a confirmed sale'); continue; }
    if (chain.some((item, i) => !Number.isFinite(Number(item.createdAt)) || !Number.isFinite(Number(item.endAt))
      || Number(item.endAt) <= Number(item.createdAt)
      || i > 0 && Number(chain[i - 1].endAt) > Number(item.createdAt)))
      { reject(purchase, 'listing chain has missing timestamps or overlapping copies'); continue; }
    const final = chain.at(-1), salePrice = Number(final.finalPrice);
    const soldAt = Number(final.settledAt ?? final.endAt);
    if (!Number.isSafeInteger(salePrice) || salePrice <= 0 || !Number.isFinite(soldAt))
      { reject(purchase, 'final sale price is not confirmed'); continue; }
    const within = events.filter((event) => eventAt(event) >= Number(bid.placedAt ?? purchasedAt)
      && eventAt(event) <= Math.max(soldAt, ...chain.map((item) => Number(item.settledAt ?? item.endAt))));
    if (within.some((event) => event.type === 'trade-offer-accepted'
      || event.type === 'pack-opened' && (!Array.isArray(event.cards)
        || event.cards.some((card) => card.cardId === purchase.cardId))))
      { reject(purchase, 'intervening pack arrival or accepted trade makes copy lineage ambiguous'); continue; }
    if (chain.some((item) => !events.some((event) => event.type === 'listed'
      && event.auctionId === item.auctionId && event.cardId === purchase.cardId && Number(event.price) === Number(item.price))
      || !events.some((event) => event.type === 'auction-result' && event.auctionId === item.auctionId
        && event.cardId === purchase.cardId && event.status === item.status
        && Number(event.startPrice) === Number(item.price)
        && (item.status !== 'settled_sold' || Number(event.finalPrice) === salePrice))))
      { reject(purchase, 'listing or settlement journal does not verify every chain link'); continue; }
    const result = events.find((event) => event.type === 'auction-result' && event.auctionId === final.auctionId);
    if (!result?.bids?.length || !result.bids.some((bid) => Number(bid.amount) === salePrice
      && bid.bidderId && !ownIds.has(bid.bidderId)))
      { reject(purchase, 'final sale has no verified external paying bidder'); continue; }
    const copyIds = chain.map((item) => item.userCardId);
    if (Object.entries(data.purchases ?? {}).some(([id]) => id !== copyId && copyIds.includes(id)))
      { reject(purchase, 'a reminted copy already belongs to another purchase'); continue; }
    repairs.push({ acquisitionAuctionId: purchase.auctionId, cardId: purchase.cardId,
      title: final.title ?? purchase.title ?? '', rarity: purchase.rarity, shiny: Boolean(purchase.shiny),
      previousUserCardId: copyId, userCardId: final.userCardId,
      chainAuctionIds: chain.map((item) => item.auctionId), copyIds,
      purchasePrice: price, accruedFees: Number(purchase.accruedFees ?? 0),
      saleAuctionId: final.auctionId, salePrice, soldAt,
      realizedProfit: salePrice - price - Number(purchase.accruedFees ?? 0),
      reason: 'unique paid acquisition, empty prior inventory, serial exact-variant remints and external final sale' });
  }
  return { repairs, rejected };
}

/** Apply to an in-memory checkpoint only; the CLI owns backups and file writes. */
export function applyPurchaseLedgerRepairs(data, repairs, { now = Date.now() } = {}) {
  const audit = [];
  for (const repair of repairs) {
    const purchase = data.purchases?.[repair.previousUserCardId];
    if (!purchase) {
      if (data.purchases?.[repair.userCardId]?.ledgerRepair?.acquisitionAuctionId === repair.acquisitionAuctionId) continue;
      throw new Error('repair proposal is stale: original purchase is absent');
    }
    if (purchase.status === 'sold') continue;
    if (purchase.auctionId !== repair.acquisitionAuctionId || Number(purchase.purchasePrice) !== repair.purchasePrice
      || Number(purchase.accruedFees ?? 0) !== repair.accruedFees)
      throw new Error('repair proposal is stale: purchase accounting changed');
    purchase.previousUserCardIds = [...new Set([...(purchase.previousUserCardIds ?? []), ...repair.copyIds.slice(0, -1)])];
    purchase.userCardId = repair.userCardId;
    purchase.status = 'sold';
    purchase.salePrice = repair.salePrice;
    purchase.soldAt = repair.soldAt;
    purchase.saleAuctionId = repair.saleAuctionId;
    purchase.realizedProfit = repair.realizedProfit;
    purchase.ledgerRepair = { at: now, acquisitionAuctionId: repair.acquisitionAuctionId,
      chainAuctionIds: repair.chainAuctionIds, version: 1 };
    data.purchases[repair.userCardId] = purchase;
    delete data.purchases[repair.previousUserCardId];
    for (const auctionId of repair.chainAuctionIds) {
      const listing = data.listings[auctionId];
      listing.previousUserCardId ??= listing.userCardId;
      listing.userCardId = repair.userCardId;
    }
    const bid = data.bids?.[repair.acquisitionAuctionId];
    if (bid) { bid.previousUserCardId ??= bid.userCardId; bid.userCardId = repair.userCardId; }
    for (const oldId of repair.copyIds.slice(0, -1)) {
      if (data.lastUnsoldByCopy?.[oldId]) {
        const old = data.lastUnsoldByCopy[oldId], current = data.lastUnsoldByCopy[repair.userCardId];
        if (!current || Number(old.endAt) > Number(current.endAt)) data.lastUnsoldByCopy[repair.userCardId] = old;
        delete data.lastUnsoldByCopy[oldId];
      }
      if (data.premiumCopies?.[oldId]) {
        data.premiumCopies[repair.userCardId] ??= data.premiumCopies[oldId];
        delete data.premiumCopies[oldId];
      }
    }
    audit.push({ at: now, type: 'deal-ledger-repaired', ...repair });
  }
  return audit;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--apply', '--help'].includes(arg))) throw new Error('Only --apply or --help are supported.');
  if (args.includes('--help')) {
    console.log('Repair verified premium resale copy lineage. Default: read-only proposal. Use --apply only while the money bot is stopped.');
    return;
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const statePath = path.join(root, 'state.premium.json'), eventsPath = path.join(root, 'events.premium.jsonl');
  const stateText = fs.readFileSync(statePath, 'utf8'), eventsText = fs.readFileSync(eventsPath, 'utf8');
  const data = JSON.parse(stateText);
  if (args.includes('--apply')) {
    if (data.paused !== true) throw new Error('Pause the premium bot and stop the money bot before applying ledger repairs.');
    let port = 8789;
    try { port = Number(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).ui?.port ?? port); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Configured dashboard port is invalid.');
    let reachable = false;
    try {
      await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
      reachable = true;
    } catch (error) {
      // An HTTP response proves that the dashboard still runs. A timeout does
      // not prove that it stopped, so only a refused connection permits apply.
      if (error.cause?.code !== 'ECONNREFUSED')
        throw new Error('Could not verify that the money bot dashboard is stopped.');
    }
    if (reachable) throw new Error('The money bot dashboard is still reachable. Stop it before applying ledger repairs.');
  }
  const events = eventsText.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  let standardId = null;
  try { standardId = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).accountId; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const proposal = proposePurchaseLedgerRepairs(data, events, { controlledUserIds: [standardId] });
  const output = { mode: args.includes('--apply') ? 'apply' : 'dry-run', statePath, eventsPath,
    applyRequiresStoppedBot: true, ...proposal };
  if (!args.includes('--apply') || !proposal.repairs.length) { console.log(JSON.stringify(output, null, 2)); return; }
  const audit = applyPurchaseLedgerRepairs(data, proposal.repairs);
  if (digest(fs.readFileSync(statePath, 'utf8')) !== digest(stateText)
    || digest(fs.readFileSync(eventsPath, 'utf8')) !== digest(eventsText))
    throw new Error('Checkpoint or journal changed. Stop the money bot before applying repairs.');
  const backupDir = path.join(root, 'archives', 'ledger-repairs');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPrefix = path.join(backupDir, `${Date.now()}`);
  fs.writeFileSync(`${backupPrefix}.state.json`, stateText, { flag: 'wx' });
  fs.writeFileSync(`${backupPrefix}.events.jsonl`, eventsText, { flag: 'wx' });
  const temporary = `${statePath}.ledger-repair.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data), { flag: 'wx' });
  fs.renameSync(temporary, statePath);
  fs.appendFileSync(eventsPath, (eventsText.endsWith('\n') ? '' : '\n')
    + audit.map((event) => JSON.stringify(event)).join('\n') + '\n');
  console.log(JSON.stringify({ ...output, applied: audit.length, backupPrefix }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
