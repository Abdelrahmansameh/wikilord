import fs from 'node:fs';

export const ROOT = new URL('../', import.meta.url);

const DEFAULTS = {
  port: 8788,
  // Fetch the "ending soon" list this often, paging until it covers at least coverSec ahead.
  pollMs: 3000,
  coverSec: 20,
  maxPagesPerCycle: 25,
  // Recent listings use their own paginated sweep and a persisted completion watermark.
  recentPollMs: 3000,
  maxRecentPagesPerCycle: 25,
  recentInitialLookbackSec: 120,
  recentOverlapSec: 5,
  pendingHorizonSec: 120,
  // Per-account budget; each login gets an independent limiter.
  maxRps: 15, // ~7 auctions end per second at peak; 8/s could not keep up
  maxInflight: 40,
  // Ask for an auction's result this long after it ends, retrying with backoff until it is settled.
  settleDelayMs: 2500,
  // true = also keep each settled auction's full JSON (compressed). Off: the tables hold every field that matters.
  keepRaw: false,
  dbFile: 'market.db',
};

export function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(new URL('config.json', ROOT), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`config.json: ${e.message}`);
  }
  return { ...DEFAULTS, ...user };
}
