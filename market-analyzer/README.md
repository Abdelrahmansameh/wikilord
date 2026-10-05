# Market analyzer

A standalone second bot that records new listings and auction results on the wiki-masters marketplace into a
local SQLite database, and serves a dashboard to analyse them. It shares no code, files or login with the
trading bot in the parent folder. Run it on its own account.

## Run

```
start-market.bat          (or: npm start, from this folder)
```

Dashboard: http://localhost:8788. On first start, open the **Collector** tab and paste the cookie
(wiki-masters.com → F12 → Network → any `api/` request → copy the `cookie:` request header, or "Copy as cURL").
It's checked against the site, then saved to `market-analyzer/.env`. After that, the session refreshes itself.
To add another account, sign in as a **different player** and paste that cookie into **Account 2** or **Account 3** on the
Collector tab. Their cookies are saved separately in `.env.secondary` and `.env.tertiary`; all sessions refresh independently.
The collector works while you prepare additional accounts.

Requires Node 22.13+ (uses the built-in `node:sqlite`, so there's nothing to install).

## How it collects

1. **New listings:** every `recentPollMs`, fetch `/api/marketplace?sort=recent` newest first. The scanner pages
   back to a persisted completion point, including a small overlap. Large backlogs continue across cycles and
   restarts without advancing the completion point early.
2. **Ending sweep:** every `pollMs`, fetch `/api/marketplace?sort=ending_soon` page by page until the list reaches
   `coverSec` seconds into the future. Each auction's latest snapshot is saved.
3. **Settle:** `settleDelayMs` after an auction ends, fetch `/api/marketplace/:id` for the outcome
   (`settled_sold` / `settled_unsold` / `cancelled`), the final price, the winner and the **full bid history**. If it's still
   active (not settled yet, or extended by a late bid), it retries after the new end.

Each account has its own `maxRps` request budget. Accounts 1 and 2 run the normal listing scans and fetch auction results.
Account 3 independently scans both listing feeds, with minimum delays of `scoutPollMs` and `scoutRecentPollMs`
between completed sweeps (1 second by default). It also probes page one of each feed between deeper sweeps, with
a `scoutHeadPollMs` minimum delay. It never fetches auction-result details. Slow site responses can
make the actual scan interval longer. The scout has its own persisted recent-feed progress; its discoveries enter
the same pending-results queue, where accounts 1 and 2 fetch the outcomes. All accounts share one SQLite
writer. Auction ID and bid ID are primary keys. A listing seen on both feeds or accounts updates the same row;
storing a final result again cannot inflate sales counts. Conflicting identities/results are recorded in
`ingest_conflicts` for inspection. An unresolved detail is retried, including temporary 404s. On HTTP 429/5xx
the affected account slows down for a minute. Results still waiting at shutdown are picked up again on restart.
The site may impose a shared IP limit, so additional accounts do not guarantee proportional throughput.

The **Collector** tab shows each account's activity and listing sightings. **Scout only** counts distinct listings first
recorded since dedicated scout mode began that account 3 has seen but accounts 1 and 2 have not seen. It also shows how
many have final results. This measures observed extra listings while the normal scans continue; it can decrease if the
normal scans later see the same listings. Historical sightings before this version cannot be attributed to an account.
The tab also shows recent-listing progress, results waiting, errors and "coverage gaps": time windows an ending sweep
couldn't reach before they ended. If gaps grow, raise `maxRps` or lower `pollMs`.

## Database (`market.db`)

| table | one row per | notes |
|---|---|---|
| `auctions` | auction ID | new listings have `final = 0`; the final result and bid history set it to `1`. `seen_recent_at` and `seen_ending_at` show feed overlap. Times are epoch ms. |
| `bids` | bid | amount, bidder, `placed_at` |
| `users` | player | latest username/avatar |
| `cards` | card | current stats + Wikipedia summary |
| `raw` | auction | empty unless `keepRaw: true`: the full detail JSON, brotli-compressed. Off by default; an audit of 10k auctions showed the tables hold every field except avatar positions. |
| `ingest_conflicts` | auction ID with contradictory data | identity or final result discrepancies are held for inspection rather than overwriting a record. |
| `auction_account_seen` | listing ID and account slot | first and latest sighting of an auction in that account's recent or ending-soon list response; used for account comparisons. |

Open it with any SQLite tool (DB Browser for SQLite, `sqlite3`, DBeaver) for ad-hoc queries. For example:

```sql
SELECT rarity, COUNT(*), AVG(final_price) FROM auctions
WHERE status = 'settled_sold' AND end_at > (strftime('%s','now') - 86400) * 1000 GROUP BY rarity;
```

## Dashboard

- **Overview:** volume, sell-through, markup, auctions ended over time, the latest results, and distributions of sales and recorded auction appearances per card.
- **Prices:** price spread (p10…p90) per rarity/shiny, price distribution, price vs pageviews or starting price scatter,
  "estimate a card" from sales of the same rarity/shininess, starting price vs sell-through, top categories.
- **Timing:** when winning bids and all bids land, plus hour-of-day, weekday and listing length vs outcome.
- **Players:** top buyers, sellers and bidders (including bids in the final minute). Click a name to see their auctions.
- **Browse:** search final results, cancelled auctions, or new active listings. Click one for its bids, other sales of the same card, and
  comparable prices.
- **Cards:** search by title or exact card ID and inspect that card's recorded listings, sale prices, bid activity, and auction history. Searches do not start ranking queries.
  Card stats use its full recorded history, regardless of the top dashboard filters.
- **Rankings:** the top 500 cards by recorded sales, median sale price, total traded value, or auctions ended; choose the metric from its menu or click a column header. Click a card to open its details in Cards.
- **Collector:** health, request rate, login.

Filters at the top (time range, rarity, shiny) apply to the aggregate views. Cards and Rankings use full recorded history.

Dashboard queries run in worker threads with their own read-only SQLite connections. Long all-time queries
therefore do not block the collector's timers, requests, or login refresh. The collector remains the only database
writer; cookies stay in the collector process. One worker answers card, auction and search lookups, a separate worker
handles Browse, and two others run range aggregates and card rankings, so a large search or ranking never holds up a card lookup.
Diagnostics use their own worker and start in the background, so cold historical counts cannot delay collection,
HTTP health responses, or charts. Each reader has a 32 MB page cache and a 256 MB mapping limit to bound memory use.
Database counts on the status panel refresh in the background every 10 seconds (feed and account counts every
5 minutes) and retain the last result while analysis is busy. Collector health is always read live.
Duplicate in-flight queries share one result, including equivalent filters in a different order. Foreground requests
take priority over queued cache refreshes. A request waiting more than 30 seconds leaves the queue without stopping
another query; a failed or timed-out worker is replaced on the next request.

Aggregate views are cached: a view stays fresh for one to five minutes, and after that the last result is shown
at once while a background query replaces it (results older than 30 minutes are recomputed before answering).
The first view of a new filter combination still waits for its query. Switching tabs or filters cancels the old browser
request immediately, and independent panels appear as each result arrives. Hidden tabs stop polling. Categories
tables are paged locally to keep large results responsive.

At the next start, the database builds a covering index for completed-auction analytics. This is a one-time operation
that logs its progress and adds roughly 650 MB at 2.6 million completed auctions; collection resumes after startup.
It lets the main aggregate queries read compact index rows instead of fetching the large auction records. Existing
auction and bid records are preserved. Price distributions use exact weighted counts rather than sending every sale
into JavaScript, and card charts fetch at most 200 sales. The collector runs `ANALYZE` on first start, checks all-table
planner statistics on startup, and runs `PRAGMA optimize` every 6 hours as the tables grow.
A smaller feed-count index adds about 43 MB at this size. Feed diagnostics read that index; historical account and
scout diagnostics share one ordered scan and fetch auction metadata only for relevant exclusive sightings. Timing
and Players read broad bid joins in auction-ID order to avoid random disk seeks. A one-time migration replaces the
existing bid lookup index with `(auction_id, placed_at, bidder_id)`, so Players can read bidder IDs from the index.
Keyword category price frequencies, card counts and rarity mixes aggregate raw categories before expanding tags.
Category drill-downs choose their largest sales before fetching titles and names. Browse's
"most times sold" order selects eligible cards before joining their auction histories, retaining filters and pagination.
Card title searches scan the compact title index before fetching matching metadata, and comparable prices are
shared for one minute across physical copies.

Run the sequential, read-only benchmark against the current database to check first-request and repeated-request times:

```sh
node --disable-warning=ExperimentalWarning tools/benchmark-dashboard.js --range=24h
node --disable-warning=ExperimentalWarning tools/benchmark-dashboard.js --range=all --timeout=60000
node --disable-warning=ExperimentalWarning tools/benchmark-dashboard.js --methods=cards,cardRankings,auctions --sort=median
node --disable-warning=ExperimentalWarning tools/benchmark-dashboard.js --url=http://127.0.0.1:8788 --range=all --timeout=60000
```

The benchmark uses analysis workers and does not start the collector or contact the site. Each JSON line reports the
method, elapsed milliseconds and response size. `--db=path`, `--rarity=R`, `--shiny=0`, `--search=title`, and
`--methods=card --id=card-id` select a database or narrower workload. Query timing includes worker startup and the
current disk/OS cache conditions; it does not deliberately flush the operating system's cache.
Use `--url` to measure the running server, its existing caches, and HTTP overhead without adding more SQLite readers.
Use `--mode=word` for category keywords or `--methods=categoryDetail --mode=exact --group=category-text` for a drill-down.
Use `--methods=auctions --sort=resold`, `--status=active`, or `--query=title` to test Browse variants;
`--player=username` selects a Players search.

## Config

Copy `config.example.json` to `config.json` and change only what you need. `port`, `maxRps`, `pollMs` and
`coverSec` are the useful ones.

`requestTimeoutMs` defaults to 30000 and bounds each account request after its rate slot is granted.
Session requests and shared token renewals also have 15-second deadlines, covering response bodies
as well as headers. Stalled requests release their processing slots and retry with the existing backoff;
late replies cannot update cookies or finalize an expired attempt. Recent-feed bridges longer than one
cycle persist their remaining gap instead of repeatedly scanning only the first pages.
