import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { salesFor } from '../src/market-db.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const targetsPath = path.join(root, 'targets.json');
const apply = process.argv.includes('--apply');
const reportPath = path.join(root, 'tmp', `for-ahmed-market-discount-${apply ? 'applied' : 'preview'}.json`);
const targets = JSON.parse(fs.readFileSync(targetsPath, 'utf8')).targets
  .filter((t) => t.theme === 'for-ahmed');
const sales = await salesFor(targets.map((t) => t.cardId));
const byId = new Map(sales.map((s) => [s.cardId, s]));

const report = { theme: 'for-ahmed', mode: apply ? 'apply' : 'dry-run', updated: [], alreadyAtDiscount: [], noMedian: [], errors: [] };
for (const target of targets) {
  // Use the same rarity-specific, non-shiny median as the previous market-price update.
  const group = byId.get(target.cardId)?.sold?.[target.rarity];
  const median = group?.median;
  if (!Number.isFinite(median)) {
    report.noMedian.push({ title: target.title, rarity: target.rarity, currentMaxBid: target.maxBid });
    continue;
  }

  // Bid amounts are whole coins and maxBid must stay at least 1.
  const discounted = Math.max(1, Math.floor(median * 0.75));
  if (target.maxBid === discounted) {
    report.alreadyAtDiscount.push({ title: target.title, rarity: target.rarity, median, discounted, sales: group.n });
    continue;
  }

  const change = { title: target.title, cardId: target.cardId, rarity: target.rarity, oldMaxBid: target.maxBid, median, newMaxBid: discounted, sales: group.n };
  if (apply) {
    const result = spawnSync(process.execPath, ['src/agent.js', 'target', 'set', target.cardId, '--max', String(discounted)], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      report.errors.push({ ...change, error: (result.stderr || result.stdout || `exit ${result.status}`).trim() });
      break;
    }
    change.result = result.stdout.trim();
  }
  report.updated.push(change);
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  mode: report.mode,
  targets: targets.length,
  updated: report.updated.length,
  alreadyAtDiscount: report.alreadyAtDiscount.length,
  noMedian: report.noMedian.length,
  errors: report.errors.length,
  report: path.relative(root, reportPath),
}, null, 2));
if (report.errors.length) process.exitCode = 1;
