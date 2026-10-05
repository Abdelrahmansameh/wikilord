# Money bot: standard and premium accounts

One process runs two independent WikiMasters money accounts against the same read-only market analyzer database. The [standard dashboard](http://localhost:8789/) retains the pack, sell, and recycle strategy. The [premium dashboard](http://localhost:8789/premium/overview) combines expensive premium deals with affordable cards that have proven resale demand. Its Deals, History, and Settings pages show the persistent watchlist, scheduled bids, candidate reasons, available cash, resale floors, and realized profit.

Each account needs a different WikiMasters login. The process rejects a login already used by the other money account, trading bot, or market analyzer. The standard account uses `.env`, `.session.json`, `config.json`, `state.json`, and `events.jsonl`. The premium account uses `.env.premium`, `.session.premium.json`, `premium.config.json`, `state.premium.json`, and `events.premium.jsonl`. The two engines share model reads only. Do not run two money-bot processes against the same accounts.

## Start and activation

Use Node 22.13 or newer. From this directory run `npm start`, then connect each account on its dashboard. On first start, `config.json` and `premium.config.json` are created from their example files. Both default to dry-run. Their pages and APIs work independently even when one account has no cookie yet.

Live actions require **both** the account's `dryRun: false` and its own process flag:

| Command | Standard account | Premium account |
| --- | --- | --- |
| `npm start` | Dry run | Dry run |
| `npm run live` | May be live | Dry run |
| `npm run live-premium` | Dry run | May be live |
| `npm run live-both` | May be live | May be live |

The premium Settings page validates and durably queues the premium selling and buying knobs. Saved changes apply between account activities; the current cycle finishes with its existing settings. A newer save replaces the pending values, and pending changes survive page refreshes and process restarts. The page shows queued, applying, applied, or failed status. Changing a buy rule recalculates pending bids against the new rules. Saving `dryRun: false` cannot activate the premium account unless this process was started with `--live-premium`. Start in dry-run to inspect proposed snipes and outcomes before enabling that flag. Existing configuration files retain legacy buying unless `buy.hybridEnabled` is explicitly enabled; loading an old file adds the new editable defaults in memory without overwriting its saved settings. New example configurations enable hybrid buying and remain dry-run.

## Premium decisions

A premium pack card is an exact card ID, rarity, and shiny variant with at least four completed sales and a median final price strictly above 500 coins. Its first ask may be above the median, up to 1.25×, subject to a modeled one-hour sale chance of at least 25%. An unsold pack listing steps down by 5%. Premium cards take priority in the five listing slots and are held rather than routinely recycled. Purchased copies follow the resale plan used to price their acquisition.

Hybrid buying has two lanes. Premium variants keep the expensive-card pool, with at least eight exact-variant sales; affordable variants need at least twelve. Both need at least four distinct buyers and three distinct sellers in recent exact-variant history, with the bot's controlled accounts excluded from demand proof. Unknown cards and different rarity or shiny variants cannot supply that proof. Price modeling uses up to 14 days of history, a 72-hour recency half-life, completed sales and unsold listings, downweighted repeated asks, and evidence compatible with the planned auction duration. The quote blends the central sale estimate 50% toward its lower estimate.

The buyer evaluates resale over **six one-hour attempts**, rather than requiring success on the first listing. It requires an estimated 85% chance of selling during those attempts. A correlation allowance of 0.5 makes repeated attempts less valuable than independent trials, because weak demand can affect every listing. The acquisition quote includes declining asks, expected listing fees, listing-slot cost, and zero cash credit for copies still unsold after the modeled attempts. The cautious one-hour sale estimate must also reach 65%. It also limits the exit ask to recorded lower-quartile prices and 85% of the median. Affordable purchases apply a further 0.8 opening-ask multiplier (`buy.liquidResaleAskRatio`); bid ceilings budget for this lower price and assume no additional bidding uplift. These are forecasts from market history, not guarantees.

The default premium bid ceiling leaves at least **200 coins and 35% return on purchase cost** after the model's allowances; affordable bids leave at least **75 coins and 60% return**. Both also require at least 50 coins of expected net profit per occupied selling-slot hour, charge at least 25 coins of opportunity cost per slot-hour, and cap the purchase at 60% of the planned first resale ask. The stricter constraint sets the ceiling. These lane targets replace the legacy universal 200-coin rule when hybrid buying is enabled. The reserve remains the larger of 1,000 coins or 50% of account capital, including held bids and the cost basis of unsold purchases. Live checks and counterbids enforce both the resale ceiling and that reserve.

The proven-variant registry scans both lanes every 15 seconds. Up to 2,000 watched auctions can persist across scans and restarts without reserving cash; a missing fresh-feed row does not delete a watched listing. At most five unsold purchased copies, leading or uncertain bids, unmatched wins, and funded plans can be committed in total, including purchased copies currently listed or awaiting return. This capacity is checked again immediately before posting a bid. Funded candidates rank by expected net profit per selling-slot hour, then total profit; the large watchlist stays intact when capacity is full. Cash is reserved for at most five scheduled bids within 15 minutes of auction end. Live prices refresh near the bid window, with a bounded request budget and spacing. The buyer evaluates up to 240 candidates per scan, reusing exact-variant quotes for 60 seconds, and can counterbid up to six times while below its ceiling. The Deals page separates these watched listings from funded scheduled bids and shows each lane, ceiling, margin, and estimated sale chance over the allowed attempts.

Stricter acquisition filters do not raise existing purchase floors or stall their recorded exit plans. A won copy keeps its acquisition resale plan, actual purchase cost, fees, and failed-listing history even when the site returns a new copy ID. Affordable copies with older plans receive the same opening-ask reduction on their next listing, without discounting new plans twice. Current auctions finish normally. It starts at the adjusted planned ask and steps down 8% after each unsold auction, while retaining a floor of actual cost plus the larger of its coin margin or return target, accrued fees, and the next listing fee. Six unsuccessful attempts park the copy for review rather than forcing a loss. Bought active listings are protected from automatic slot replacement. The buying and selling models include the account's own unsold listings, with duplicate market records excluded.

Ending auctions with aging quotes receive priority over distant work. A prior capacity or cash rejection clears once the candidate's existing economic approval and current funding checks pass. The Deals API reports scan duration and live-read backoff to make delays visible.

Live auction checks persist observed bids and extended end times in the watchlist. Economic rejection invalidates the earlier approval, and older analyzer snapshots cannot lower an observed bid and recreate a cheap funded plan.

Listings made outside the bot can be linked back to a missing purchase using current account listings and the analyzer's read-only exact history. Recovery requires unique ownership and chronological evidence; missing or ambiguous copies stay committed. The recovered listing retains the cost basis, counts its configured fee once, follows normal sale accounting and stays outside the duration experiment.

The shared model refreshes by building a replacement read-only worker while the current worker keeps serving pricing and final bid checks. It swaps only when the replacement is ready, drains outstanding old requests before closing their worker, and retains the current model if the rebuild fails. Existing freshness checks still apply. Shutdown cancels unfinished builds.

The shared model stores an optional private calibration cache in `market-calibration.cache.json`. A reload can reuse a valid earlier fit less than six market-data hours old for the same database identity. Historical evaluations cannot reuse future fits or overwrite this cache. Missing or invalid records cause normal recalibration; market summaries still rebuild from current read-only data.

Market estimates can be wrong or change before resale. The Deals page keeps held bids and unsold purchase cost visible, and pack income is separate from purchased-card resale profit. Dry-run auction outcomes estimate whether a proposed bid would have won; they do not demonstrate realized resale profit. All buying defaults are editable on the premium Settings page.

## Existing controls and records

Premium Settings includes an optional **Listing duration experiment**. It
independently assigns each new premium-account listing to 10 minutes or one
hour with a 50/50 chance, including purchased-card resales. Price selection is
held consistent between durations; sale estimates still describe the one-hour
pricing model. The premium Overview compares actual sales, unsold outcomes,
cancellations, net listing proceeds per occupied slot-hour and realized resale
profit, with separate inventory and purchased-card views. Assignments and
outcomes survive restarts. Existing listings and dry-run proposals are excluded.
Standard listings remain on their configured one-hour duration.

Both accounts open free packs, quote inventory against the analyzer's auction history, fill spare listing slots, and recycle weak routine cards. After completing a human check on the site, use **Retry after verification** to acknowledge old notices, retry packs, and re-evaluate still-open auctions blocked by that check. Buying waits after a verification rejection instead of sending further blocked bids; that wait survives restarts. Recovery preserves bid ceilings and reserves, excludes expired auctions and tracked bids, and rechecks the live auction before bidding. A new challenge restores the wait and notice. A failed discard is recorded and retried later. The bot reconciles listings and bids after a restart before making new choices. The dashboard shows price curves and exact-card auction history; each History page reads only its account's durable JSONL journal.

The analyzer must be running and its database current. The money process never writes to `market.db`; it pauses live decisions when the market model is unavailable or stale. The default market age limit is 24 hours and model refresh is every 30 minutes. The standard settings remain in `config.json`. Its existing dashboard routes and API paths stay available.

On large databases, the first shared model build can take several minutes. Both accounts share one lazy build and coalesced refreshes; a freshly built model is not immediately rebuilt. Broad discovery and model-building queries use sequential scans to avoid poorly estimated indexes causing repeated random reads. Later refreshes reuse the premium calibration until six hours of newer market history have accumulated.

For older sales whose returned copy IDs broke purchase accounting, `node tools/repair-purchase-ledger.mjs` prints a read-only repair proposal. It requires a unique, journal-verified acquisition and serial unsold return chain ending in an external sale, with no ambiguous pack arrivals or accepted trades. `--apply` requires the premium checkpoint paused and the money dashboard stopped; it backs up the checkpoint and journal, preserves acquisition costs and fees, and records the repair without adding sale revenue twice.

The owner-restricted phone viewer proxies this dashboard on local port 8793; premium routes use the same proxy. Expose it to your tailnet with `tailscale serve --bg --https=8445 8793` if desired.

Run `npm test` for pricing, engine, deal, dashboard, and account-isolation checks.

To investigate purchase rejections without trading, run
`node --disable-warning=ExperimentalWarning tools/audit-deal-strategy.mjs --limit=2000`
against the existing dashboard (`--url=http://127.0.0.1:8789` is the default).
It compares buying profiles using watched prices and read-only exact-variant
history, including slot costs, own failed listings and the current calibration.
The report counts economic opportunities; final prices, reserves, capacity and
owned copies can still prevent bids. It is a snapshot comparison, not evidence
of realized profit. No settings are changed by the audit.
