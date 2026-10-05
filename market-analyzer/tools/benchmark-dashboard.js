// Read-only, sequential dashboard benchmark. No collector sessions, writer migrations or site requests.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AnalysisClient } from '../src/analysis-client.js';

const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));
const root = fileURLToPath(new URL('../', import.meta.url));
const file = path.resolve(root, options.db || 'market.db');
const timeoutMs = Math.max(100, Number(options.timeout) || 30_000);
const client = new AnalysisClient(file, { timeoutMs, queueTimeoutMs: timeoutMs });
const q = { range: options.range || '24h' };
if (options.rarity) q.rarity = options.rarity;
if (options.shiny === '0' || options.shiny === '1') q.shiny = options.shiny;
if (options.tz) q.tz = options.tz;
if (options.mode) q.mode = options.mode;
if (options.group) q.g = options.group;
for (const field of ['status', 'player', 'page', 'minPrice']) if (options[field]) q[field] = options[field];
if (options.query) q.q = options.query;
const methods = (options.methods || 'overview,prices,startingPrice,turnover,auctionAppearances,scatter,categoryGroups,timing,players,auctions,cards,cardRankings').split(',');
const routes = { auctionAppearances: 'auction-appearances', categoryGroups: 'category-groups', categoryDetail: 'category-detail',
  cardRankings: 'card-rankings', startingPrice: 'prices' };
async function run(method, args) {
  if (!options.url) return client.call(method, ...args);
  const url = new URL(`/api/${routes[method] || method}`, options.url);
  const filters = method === 'cards' || method === 'users' ? { q: args[0] } : method === 'cardRankings' ? { sort: args[0] } :
    method === 'card' || method === 'auction' ? { id: args[0] } : args[0];
  for (const [key, value] of Object.entries(filters || {})) if (value != null) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const value = await response.json();
  if (!response.ok || value?.error) throw new Error(value?.error || `HTTP ${response.status}`);
  return method === 'startingPrice' ? value.start : value;
}

try {
  for (const method of methods) {
    const args = method === 'cards' ? [options.search || ''] : method === 'cardRankings' ? [options.sort || 'sold'] :
      method === 'card' || method === 'auction' ? [options.id] : [{ ...q,
        ...(method === 'auctions' && options.sort ? { sort: options.sort } : {}),
        ...(method === 'scatter' ? { rarity: options.rarity || 'R', x: 'q_score' } : {}) }];
    const started = performance.now();
    try {
      const value = await run(method, args);
      const queryMs = performance.now() - started;
      const cachedAt = performance.now();
      await run(method, args);
      const repeatMs = performance.now() - cachedAt;
      console.log(JSON.stringify({ method, range: q.range, queryMs: Math.round(queryMs), repeatMs: Math.round(repeatMs),
        responseBytes: Buffer.byteLength(JSON.stringify(value)) }));
    } catch (error) {
      console.log(JSON.stringify({ method, range: q.range, queryMs: Math.round(performance.now() - started), error: error.message }));
      process.exitCode = 1;
    }
  }
} finally {
  await client.close();
}
