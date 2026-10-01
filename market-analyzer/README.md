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
To add another account, sign in as a **different player** and paste that cookie into **Account 2** on the
Collector tab. It is saved separately in `.env.secondary`; both sessions refresh independently. The collector
works with one account while you prepare the second.

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

Each account has its own `maxRps` request budget. Both accounts feed one pending-results queue and one SQLite
writer. Auction ID and bid ID are primary keys. A listing seen on both feeds or accounts updates the same row;
storing a final result again cannot inflate sales counts. Conflicting identities/results are recorded in
`ingest_conflicts` for inspection. An unresolved detail is retried, including temporary 404s. On HTTP 429/5xx
the affected account slows down for a minute. Results still waiting at shutdown are picked up again on restart.
The site may impose a shared IP limit, so two accounts do not guarantee twice the throughput.

The **Collector** tab shows each account's activity, recent-listing progress, results waiting, errors and "coverage gaps": time windows an ending sweep
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

Open it with any SQLite tool (DB Browser for SQLite, `sqlite3`, DBeaver) for ad-hoc queries. For example:

```sql
SELECT rarity, COUNT(*), AVG(final_price) FROM auctions
WHERE status = 'settled_sold' AND end_at > (strftime('%s','now') - 86400) * 1000 GROUP BY rarity;
```

## Dashboard

- **Overview:** volume, sell-through, markup, auctions ended over time, the latest results.
- **Prices:** price spread (p10…p90) per rarity/shiny, price distribution, price vs card stat scatter,
  "estimate a card" from comparable sales, starting price vs sell-through, top categories.
- **Timing:** when winning bids and all bids land, plus hour-of-day, weekday and listing length vs outcome.
- **Players:** top buyers, sellers and bidders (including bids in the final minute). Click a name to see their auctions.
- **Browse:** search final results, cancelled auctions, or new active listings. Click one for its bids, other sales of the same card, and
  comparable prices.
- **Cards:** search by title or exact card ID, then see that card's recorded listings, sale prices, bid activity, and auction history.
  Card stats use its full recorded history, regardless of the top dashboard filters.
- **Collector:** health, request rate, login.

Filters at the top (time range, rarity, shiny) apply to the aggregate views, not the Cards page.

Dashboard queries run in a separate worker with its own read-only SQLite connection. Long all-time queries
therefore do not block the collector's timers, requests, or login refresh. The collector remains the only database
writer; cookies stay in the collector process. Database counts on the status panel refresh in the background
every 10 seconds and retain the last result while analysis is busy. Collector health is always read live.
Duplicate in-flight queries share one result, and a failed or timed-out worker is replaced on the next request.
This isolates analysis work; individual historical queries can still take time to finish.

## Config

Copy `config.example.json` to `config.json` and change only what you need. `port`, `maxRps`, `pollMs` and
`coverSec` are the useful ones.
