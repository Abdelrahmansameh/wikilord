# Market analyzer

The analyzer is a separate service that records WikiMasters marketplace listings,
auction results and bid histories in SQLite. It does not buy, sell or open packs.
Its data powers the market dashboard, money-bot pricing, trading research and
Jarvis market reports.

Entry point: `market-analyzer/src/main.js`. Default dashboard:
`http://localhost:8788`. The longer
[analyzer README](../market-analyzer/README.md) covers charts, database tuning and
benchmark options.

## Collection workflow

The collector combines three activities:

1. **Recent listings:** page through the newest-first marketplace feed, returning
   to a persisted completion watermark with overlap. A backlog can span several
   cycles/restarts. The watermark advances only when the sweep completes.
   A front-of-feed bridge that exceeds one cycle saves its remaining gap as the
   catch-up cursor, so downtime does not cause the first pages to repeat forever.
2. **Ending-soon sweep:** page through near-ending listings until reaching the
   configured future coverage window. Save snapshots and schedule outcomes.
3. **Settlement:** after an auction's end plus `settleDelayMs`, fetch its detail
   and record the final status, price, winner and full bid history. Retry active,
   extended or temporarily missing results rather than treating them as final.

Accounts 1 and 2 share the normal collection workload. Optional account 3 runs
an independent listing-only scout, scanning both feeds and probing their first
pages between deeper sweeps. It sends discoveries to the normal pending-results
queue and does not fetch auction-result details. Scout recent-feed progress is
persisted separately.

Each account has its own renewal, rate budget and backoff. A game identity cannot
occupy several analyzer account slots. Site/IP limits can still constrain the
whole process; three logins do not guarantee three times the throughput.

Requests have rejecting deadlines as well as network cancellation: a session
request (including renewal and reading the response body) has a 15-second limit;
the shared token renewal has its own 15-second deadline. The account pool also
enforces `requestTimeoutMs` (default 30 seconds) after granting a rate slot. A
stalled operation releases its account/collector slots and leaves the auction
pending for the existing retry backoff. Late responses cannot save results or
replace cookies after their attempt expires. Rate-limit queue waiting is outside
the request deadline and still honors the existing per-account budget.

All collectors write through one `Store`. Listing and bid identities are
deduplicated. Seeing the same listing in several feeds/accounts does not create
another sale. Contradictory identities or final results enter
`ingest_conflicts` rather than silently replacing trusted data.

## Data and meaning

`market-analyzer/market.db` is the default database. Its location can be changed
with `dbFile`, resolved relative to the analyzer folder. Consumers must point
at the same actual file. Times in stored records and many reports are epoch
milliseconds.

| Table | Purpose |
| --- | --- |
| `auctions` | One row per listing, discovery snapshots, variant and eventual final outcome |
| `bids` | Recorded bids with amounts, players and timestamps |
| `cards` | Card/article metadata and current stats |
| `users` | Latest recorded player identity/display metadata |
| `auction_account_seen` | First/latest feed sightings by account slot |
| `ingest_conflicts` | Conflicting auction identity/result evidence for inspection |
| `raw` | Optional compressed detail responses when `keepRaw` is enabled |

Realized sale analysis requires `final = 1 AND status = 'settled_sold'`.
`settled_unsold` means a finished listing without a sale; `cancelled` is another
outcome. `final = 0` rows are recorded listings awaiting a final result, not sales.
Active records are observations and can lag the live game.

An example read-only query:

```sql
SELECT rarity, is_shiny, COUNT(*) AS sales, AVG(final_price) AS average_price
FROM auctions
WHERE final = 1 AND status = 'settled_sold'
GROUP BY rarity, is_shiny;
```

Account-sighting diagnostics reflect observed coverage. “Scout only” can fall
when a normal account later sees a listing. Historic records collected before
account attribution was introduced cannot establish which account saw them.
Coverage gaps and unresolved outcomes mean this database is not guaranteed to
contain every marketplace event.

## Dashboard architecture

The HTTP process and collector stay responsive while analytical queries run in
worker threads with their own read-only connections:

- One lane handles card/auction details and card searches.
- Another handles Browse queries.
- Two workers handle heavier range aggregates and rankings.
- A separate diagnostics worker refreshes historical status counts.

`analysis-client.js` routes work, coalesces equivalent requests, prioritizes
foreground work and maintains caches. Aggregates normally stay fresh for one to
five minutes. Previously cached results up to thirty minutes old can be returned
while refreshing in the background. Some detail queries have shorter caches.
Collector health remains live; historical counts refresh separately.

Worker readers have bounded caches/mappings. A failed or timed-out worker can be
replaced. Browser requests cancel on tab/filter changes and hidden tabs stop
polling. Cards and Rankings use full recorded history; aggregate views honor the
dashboard's range/rarity/shiny filters.

The dashboard focuses on collection categories, sale history and market activity.
It does not display q_score or attack/defense stats. Card and auction benchmarks
and the Estimate panel compare rarity and shininess without a quality-score band;
these are broad market benchmarks, since collection demand varies by card.
The price scatter offers Wikipedia pageviews and starting price. Stored combat
metadata and the optional q_score filter on the comparable API remain available
for existing consumers.

Indexes, planner statistics and query shape matter on a database with millions
of auctions. Startup can perform index migrations before collection begins;
background diagnostics should not be allowed to become another startup barrier.

## Source map

| File | Responsibility |
| --- | --- |
| `market-analyzer/src/main.js` | Store/session setup, normal collector and scout, dashboard startup, shutdown |
| `market-analyzer/src/collector.js` | Feed sweeps, watermarks, outcome queue, retries and coverage metrics |
| `market-analyzer/src/accounts.js`, `market-analyzer/src/http.js` | Account pool, rate budgets, identity checks and sessions |
| `market-analyzer/src/db.js` | Schema, migrations, indexes, ingestion, conflict handling and writer operations |
| `market-analyzer/src/analysis.js` | Read-side market queries/statistics |
| `market-analyzer/src/analysis-client.js`, `market-analyzer/src/analysis-worker.js` | Worker scheduling, caching, diagnostics and query execution |
| `market-analyzer/src/categories.js` | Category grouping/normalization |
| `market-analyzer/src/server.js`, `market-analyzer/src/ui.html` | HTTP API and browser dashboard |
| `market-analyzer/tools/benchmark-dashboard.js` | Read-only query performance measurements |

## Configuration, running and verification

Analyzer config is loaded at startup by merging `config.json` over built-in
defaults. Missing config is allowed; the example file is a reference. There is
no trading-style config watcher, so restart to load external changes.

Important defaults include port 8788, normal/recent sweep delays of 3000 ms,
20 seconds of future coverage, settlement delay 2500 ms, and a per-account
`maxRps` of 15. Scout delays are 1000 ms minimums. These are configured delays
and ceilings, not promises about actual throughput on a slow site.

Credentials stay in analyzer-local `.env`/`.session.json`, with
`.secondary` and `.tertiary` suffixes for the additional slots. Connect them on
the Collector tab. Runtime config, DB and credentials are private.

From `market-analyzer/`, using Node 22.13+:

```powershell
npm start
npm test
node --check src/collector.js
node --disable-warning=ExperimentalWarning tools/benchmark-dashboard.js --range=24h
node --disable-warning=ExperimentalWarning tools/benchmark-dashboard.js --url=http://127.0.0.1:8788 --range=all --timeout=60000
```

Use the benchmark against an existing DB or server. It reads data without
starting collection or contacting the game. Long all-time benchmarks consume
disk/CPU, so choose the relevant query rather than running every report.
`GET /api/status` is the first health check; `/api/cards`, `/api/card`,
`/api/auctions`, `/api/auction`, `/api/overview` and `/api/prices` provide research.

## Troubleshooting and change boundaries

- Collector stale but charts available: inspect account login/rate/backoff,
  pending outcomes and feed watermarks. Cached charts do not establish collection
  health.
- Charts slow but collection healthy: inspect worker queues, query plans,
  indexes and caches. Avoid solving this on the collector thread.
- Missing sales: distinguish an undiscovered listing, a coverage gap, a pending
  detail retry, an unsold result and a conflict record.
- Duplicate-looking listings: check auction ID and copy/variant identity before
  changing deduplication. Repeated relistings are not duplicate ingestion.

Preserve unique auction/bid ingestion, restart-safe scan progress, single-writer
ownership and reader isolation. Never delete or rebuild the production database
as a routine fix. Query or ingestion changes should use the corresponding tests
under `market-analyzer/test/`; performance tests use fixtures, while production
benchmarks are explicit read-only measurements.
