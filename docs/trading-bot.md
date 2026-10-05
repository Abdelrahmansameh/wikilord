# Trading bot

The root bot acquires cards for the owner's collection. It follows explicit
targets grouped into themes and general bid rules. It can also open free packs,
sell selected cards and recycle unwanted inventory. Those secondary activities
are configurable; they are not the premium money bot's resale strategy.

Entry point: `src/bot.js`. Dashboard: `http://localhost:8787` by default.
Read [../POLICIES.md](../POLICIES.md) for the rule/config reference and
[../README.md](../README.md) for initial login setup.

## How an auction becomes a bid

1. Load validated config, sessions, targets, hard limits and durable win history.
   Open the dashboard even if a login still needs to be supplied.
2. Discover the site's public API key, renew the account session, calibrate server
   clock offset/latency, and refresh balance and wishlist.
3. Scan ending-soon auctions within page/time budgets. Additional searches find
   wishlist cards, targets and searchable bid-rule candidates.
4. Match candidates against explicit targets first, then ordered bid rules.
   Rules can skip candidates. Owned-card checks and target protections prevent
   unwanted duplicates. `cheapestPerCard` chooses among eligible copies.
5. Check target/theme eligibility, maximum price, daily/weekly limits, reserves,
   committed bids, bid spacing and higher-priority target needs.
6. Schedule the bid using server time and measured bid latency. Re-fetch the
   auction before firing; re-evaluate price and budgets instead of relying on the
   old marketplace row.
7. Track the result and auction extensions. If outbid and counters are permitted,
   schedule another attempt within the same price/budget limits.
8. Record wins/losses and card events. A won target is removed from its theme;
   durable win history continues protecting the card after target removal.

The site's last-ten-second extension rule affects sniping. The example config
targets **15 seconds remaining**, and validation requires more than 10 seconds.
Counter timing and observed latency matter as much as timers.

Themes use rolling seven-day spend plus held bids. Priority 1 is higher than
priority 2 or 3. Lower-priority and rule-driven bids yield funds needed for
higher-priority targets in the configured reserve horizon. The theme budget,
the target's max bid and `limits.json` ceilings are separate constraints.

## Packs, selling and recycling

`packs.js` checks availability and opens packs with randomized gaps. Recycling
uses ordered keep/recycle rules and protection checks. Pack arrivals and card
actions enter `cards.jsonl`. Human checks produce a visible notice/backoff and
require the owner to complete verification on the site.

`sell.js` fetches inventory and existing listings, protects collection cards,
and fills configured sale slots with the best eligible values. The usual price
is a configurable fraction of the site's average sale price, default 0.75.
`values.js` maintains the dashboard's inventory valuation cache. This selling
logic is distinct from the probability curves used by the money bots.

Wishlisted, theme/target and historically purchased collection cards are
important protections. Changing or removing a target must not erase the
historical protection used by automatic selling and recycling.

## Source map

| File | Responsibility |
| --- | --- |
| `src/bot.js` | Orchestration, discovery scans, budgets, plans, bid firing, counters and reports |
| `src/rules.js` | Normalize card/auction facts and evaluate conditions/decisions |
| `src/config.js` | Config schema, loading and file watching |
| `src/targets.js` | Target/theme operations, hard limits, journaling and purchased-target cleanup |
| `src/snipe-selection.js`, `src/counter-timing.js`, `src/clock.js` | Candidate choice and timing calculations |
| `src/http.js` | Cookie parsing, API-key discovery, session renewal and requests |
| `src/history.js` | Durable card events, wins and purchased-card protection |
| `src/packs.js`, `src/sell.js`, `src/values.js` | Pack/recycle loop, automatic sales, valuation/manual actions |
| `src/ui.js`, `src/ui.html` | Local dashboard and its API |
| `src/agent.js`, `src/discover.js`, `src/market-db.js` | Strategy CLI, card discovery, read-only recorded sale research |
| `src/explain.js` | Read-only explanation of current rule decisions |
| `tools/supervise.cjs`, `tools/stop-bot.ps1` | Windows process supervision and stopping |

## Configuration and durable context

Root paths: `config.json` controls operations; `targets.json` contains themes and
targets; `limits.json` sets hard ceilings; `.env` and `.session.json` hold login
material. `bids.jsonl` records bid attempts and timing events. `cards.jsonl`
preserves card actions and win history across restarts. `journal.jsonl` records
strategy/target changes. `values.json` is a valuation cache, not the card ledger.

`config.json`, targets and limits are re-read on changes. Most policy changes
apply within roughly three seconds. `dryRun`, process `--live`,
`timing.pollSeconds` and `timing.recalibrateMinutes` require a restart; saving
config alone does not rebuild those startup decisions/timers.

The optional strategy agent reads `strategy.md` and uses the CLI to manage
targets/themes. Its manual is [../AGENT.md](../AGENT.md), which includes specific
scheduled-run rules. It is separate from Jarvis and is not required for trading.
One-off scripts under `tools/` that mention Ahmed are maintenance utilities;
inspect their inputs and mutation behavior before using them.

## Run, inspect and validate

From the repository root:

```powershell
npm start                     # dry-run process; still reads the site
npm run live                  # live-capable, also needs dryRun:false
node src/agent.js help         # command reference
node src/agent.js status       # inspect running bot
node src/agent.js sales <ids>  # local analyzer history; requires SQLite runtime
npm run explain               # read-only, can contact the site
npm run check-config           # validate the personal config
node --test src/counter-timing.test.js src/snipe-selection.test.js src/purchased-targets.test.js
node --check src/bot.js        # syntax check; use on edited JS files
```

The dashboard's useful reads include `GET /api/state`, `/api/report`,
`/api/targets`, `/api/limits`, `/api/journal` and `/api/cards-history`.
Read-only inspection is different from `/api/scan`, `/api/packs/retry`,
`/api/restart`, wishlist changes and manual sell/recycle controls.

`start-bot.bat` stops existing trading processes and starts the supervisor with
`--live`; an exited child restarts after ten seconds and writes `bot.log`.
`npm run live` alone has no supervisor. Do not use either launcher to validate
a documentation change.

## Troubleshooting and change boundaries

- No snipes: inspect mode/pause, active targets, ownership, rule ordering, theme
  budgets, held bids and reserve calculations before changing the scanner.
- Late bids/extensions: inspect server offset, bid round trips, pre-check timing
  and counter scheduling. A smaller remaining-time target can trigger extensions.
- No login: reconnect via the dashboard; never paste cookies into documentation.
- Missing collection protection: investigate `cards.jsonl` and `wonCardIds`, not
  just the current target list. Do not delete history to fix a display issue.
- Pricing research unavailable: verify the analyzer DB path/runtime. Core
  rule-based bidding does not require the analyzer's HTTP dashboard.

Preserve budget checks both when scheduling and when firing. Keep human-check
handling and protections on automatic sale/recycle paths. Update tests for
behavioral changes that can alter spending, card loss or win attribution.
