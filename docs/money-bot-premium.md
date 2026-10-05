# Premium money bot

The premium money account combines pack income, premium card sales and buying
undervalued auctions for resale. It uses recorded demand to choose acquisition
ceilings and exit plans. It is an independent account/ledger inside the same
process as the [standard money bot](money-bot-standard.md).

Entry point: `money-bot/src/main.js`. Dashboard:
`http://localhost:8789/premium/overview`, with Deals, History and Settings pages.
Read [../money-bot/README.md](../money-bot/README.md) for the fuller strategy
reference. Numerical values below describe example/default settings, not the
owner's current configuration or guaranteed returns.

## Two cooperating engines

`createMoneyEngine` manages inventory, packs, listings, returned copies,
recycling and accounting for this account. `createDealEngine` discovers purchase
opportunities, prices them, manages watchlists/funded plans, fires bids and
reconciles outcomes. The money engine supplies its portfolio to the deal engine
and uses recorded purchase plans when listing won cards.

The two money accounts share read-only pricing/model work, but have different
cookies, configs, checkpoints, journals, balances and live flags. The premium
engine's pause/resume also controls its deal engine. Account identity checks
apply during startup, connection and normal operation.

Model refreshes build a replacement read-only worker while the current worker
continues serving quotes and final bid checks. Only a ready replacement becomes
the shared model, and outstanding requests on the old worker finish before it is
closed. A failed replacement leaves the serving model in place; normal stale-data
checks still apply. This prevents a full rebuild from trapping snipes behind a
long pricing queue. Shutdown cancels unfinished replacement builds.

Every successful live auction read updates the watched auction's price and end
time, including pre-bid and final checks. A live economic rejection invalidates
the old approval. Later stale analyzer observations cannot replace a higher
observed bid with the old cheap price and recreate a funded plan.

## Premium inventory sales

`premium.listingDurationExperiment` is an opt-in live experiment, disabled in
example and legacy configurations. When enabled, each new premium-account
listing independently chooses 10 minutes or 60 minutes with equal probability,
including routine, exploratory, premium and purchased-card listings. Existing
auctions finish normally. Asking-price selection stays the same in both arms;
pricing forecasts and acquisition horizons still use one-hour history, so those
forecasts must not be presented as estimated ten-minute sale probabilities.
Purchase floors, fees, retry limits and copy attribution remain in effect.

Each successful listing saves the assigned duration, experiment version and
listing fee in its checkpoint and durable `listed` event. Its scheduled end
uses the actual chosen duration. Sale, unsold, cancellation and detailed-result
events retain the assignment. Actual end times include bid extensions. Older
unassigned listings and dry-run proposals are excluded from the experiment.
Each returned copy's next listing gets a new independent assignment.

The Overview page's **Listing duration comparison** shows both arms for all
inventory, pack/other inventory, or purchases. `/api/premium/state` includes
`listingDurationComparison`, computed from persisted account records, so the
report survives restarts and remains available after disabling the experiment.
Sale rate uses sold and unsold auctions; cancellations and active counts remain
separate. Net listing proceeds deduct fees for ended listings, including
cancellations, but not purchase costs. Net coins per slot-hour divides those
proceeds by observed occupied time for ended listings. Realized resale profit
is attributed to the duration of the final sold listing and deducts that copy's
purchase price and all its listing fees. Separate card sources before comparing
results; repeated attempts and changing inventory mean these descriptive
averages are not proof that one duration is better.

A premium pack variant needs at least four completed sales and a median price
strictly above 500 coins. Its initial ask can reach 1.25 times the median when
the modeled one-hour sale probability reaches 25%. Unsold pack asks step down
5%. These cards get listing-slot priority and are held rather than routinely
recycled. Spare slots can still use routine money-bot inventory decisions.

A purchased copy is handled separately: its acquisition cost, exit plan,
listing fees and attempt history determine the next resale action. Current
acquisition rules should not retroactively impose higher price floors on older
purchases. Purchased active listings are protected from automatic replacement.

## How purchasing works

1. Build a registry of proven exact variants from analyzer history. Exclude
   controlled accounts from evidence intended to prove external demand.
2. Discover active candidates and persist watched auctions. Missing a row in a
   later fresh-feed scan does not erase a watched auction.
3. Quote candidates using exact card/rarity/shiny evidence, sale and unsold
   outcomes, recency, repeated asks and compatible listing duration.
4. Construct an exit plan for several declining one-hour resale attempts. Deduct
   expected fees and selling-slot opportunity cost, then apply lane profit/ROI
   requirements to obtain a maximum bid.
5. Fund only the best candidates near auction end while preserving cash reserve
   and resale capacity. A watched auction alone does not commit cash.
6. Refresh live auction state near the bid window. Recheck reserve, price
   ceiling, portfolio exposure and verification state immediately before the bid.
7. Track leading, uncertain, won and lost bids. Counterbid only while allowed
   and below the same economic ceiling/reserve constraints.
8. Attribute a won auction to its owned copy and preserve the exit plan. On
   resale, recognize realized profit from actual costs, fees and proceeds.

Hybrid buying uses two lanes:

| Constraint | Premium lane | Affordable lane |
| --- | --- | --- |
| Minimum exact-variant completed sales | 8 | 12 |
| Distinct external buyers/sellers | At least 4 buyers and 3 sellers | Same |
| Minimum modeled net coin margin | 200 | 75 |
| Minimum return on purchase cost | 35% | 60% |
| Additional opening resale ask factor | No affordable-lane reduction | 0.8 |

The acquisition quote uses up to 14 days of history with a 72-hour recency
half-life. A risk weight blends the central estimate toward its lower estimate.
The default exit horizon is six one-hour attempts, with a modeled 85% cumulative
sale chance and at least 65% cautious one-hour sale chance. A repeat-correlation
allowance of 0.5 reduces the benefit of assuming independent retries.

The exit ask is capped using lower-quartile evidence and 85% of the median.
Both lanes require at least 50 expected net coins per occupied selling-slot
hour, budget at least 25 coins of slot cost per hour, and cap acquisition at 60%
of the planned first resale ask. No residual cash credit is assigned to a copy
still unsold after the horizon. The strictest constraint determines the bid.

Existing configs retain legacy buying unless `buy.hybridEnabled` is explicitly
enabled. Missing hybrid fields receive editable defaults in memory, with hybrid
disabled for old files. The current example enables hybrid buying while keeping
the account dry-run. Do not infer migration/activation from a new default alone.

## Capacity and cash

The default registry scan runs every 15 seconds and can retain up to 2,000
watched auctions. It evaluates up to 240 quotes per scan, caches equivalent
quotes for 60 seconds, and funds at most five plans within a 15-minute horizon.
Near-bid live refreshes use a bounded request budget and spacing.

Ending auctions whose quotes have aged beyond the cache window get priority over
distant quote work, while fresh urgent quotes yield to the normal lane rotation.
Capacity and cash rejections are temporary: after economic approval and the
current budget pass, the scheduler clears the old funding reason before planning.
`/api/premium/deals` reports scan activity/duration and a live-read backoff deadline
so slow scans can be distinguished from a lack of qualifying candidates.

Resale exposure is also capped at five commitments. It includes unsold bought
copies, copies currently listed or awaiting return, leading/uncertain bids,
unmatched wins and funded plans. A large watchlist is therefore compatible with
little or no available capacity. Plans rank by expected net profit per slot-hour,
then total expected profit.

The cash reserve is the larger of 1,000 coins or 50% of account capital,
including held bids and the cost basis of unsold purchases. Live checks and up
to six allowed counterbids preserve that reserve and the quote ceiling.

## Resale, copy identity and accounting

Purchased asks normally step down 8% after an unsold attempt. The floor includes
actual purchase cost, the greater of the recorded coin/ROI margin, accrued fees
and the next listing fee. After six failed attempts the copy is parked for
review. Affordable copies with older plans receive the opening-ask adjustment
on their next listing; new plans must not be discounted twice.

The game can return an unsold card under a new owned-copy ID. Reconciliation
must retain the acquisition, fees and plan across that remapping. Ambiguous
attribution stays protected/waiting rather than being assumed to be a pack card.
Both buying and selling account for the account's own unsold evidence, avoiding
duplicate analyzer records.

Separate pack income from purchased-card resale profit. A dry-run outcome can
estimate whether a proposed bid would have won; it does not establish actual
resale profit. Account switches archive the old account's context; they must not
merge two players' histories into one active ledger.

Listings made outside the bot are recovered for missing purchases from current
authenticated listings and bounded exact-variant history in the analyzer's
read-only model worker. Attribution requires one outstanding purchase, no
remaining owned variant, an empty pre-acquisition ownership snapshot, and one
untracked listing by this account after the purchase's last known return or
cancellation. Missing cards, duplicates and ambiguous histories alone never
release capacity. Recovered listings use normal settlement/profit accounting,
retain the purchase cost and accrue the configured listing fee once. They are
protected as purchase listings and excluded from the duration experiment because
the bot did not assign their duration. `purchase-listing-recovered` records the
attribution; repeated reconciliation cannot count a sale or fee twice.

The shared model optionally saves its premium calibration in the private
`money-bot/market-calibration.cache.json` runtime file. Reloads reuse it only for
the same database file identity and a valid earlier calibration window less than
six market-data hours old. Historical evaluations never overwrite the live cache
or use a future calibration. Invalid/missing caches trigger the usual fit. This
avoids repeating the expensive calibration audit on every process reload; the
model still rebuilds its market summaries from the read-only database.

## Source and state map

Paths are under `money-bot/` unless explicitly qualified.

| File | Responsibility |
| --- | --- |
| `src/main.js` | Shared process/model, isolated premium store/session and engine wiring |
| `src/deals.js` | Candidate registry, watchlist, quotes, funding, bid timing/counters and outcomes |
| `src/model.js` | Premium calibration and hybrid resale quote mathematics |
| `src/resale-policy.js` | Resale horizon, floors, attempts and returned-copy attribution |
| `src/listing-duration.js` | 50/50 duration assignment and persistent experiment comparisons |
| `src/engine.js` | Premium inventory sale priority, purchased-copy handling, reconciliation and trades |
| `src/config.js` | Premium/hybrid validation, migration defaults and permitted settings |
| `src/settings-queue.js` | Durable settings jobs applied between account activities |
| `src/state.js` | Premium checkpoint, durable history, snipes and account archives |
| `src/server.js`, `src/premium-ui.html` | Premium page/API routing and dashboard controls |
| `tools/repair-purchase-ledger.mjs` | Read-only repair proposal and guarded offline repair |
| `tools/audit-deal-strategy.mjs` | Read-only comparison of buying profiles against watched auctions and exact history |

Private account files are `premium.config.json`, `.env.premium`,
`.session.premium.json`, `state.premium.json` and `events.premium.jsonl`.
Archives live under `money-bot/archives/`. Preserve them and the purchase ledger
when repairing or changing account handling.

## Running and settings

From `money-bot/`, using Node 22.13+:

```powershell
npm start                  # both money accounts dry-run
npm run live-premium       # only premium is live-capable
npm run live-both          # both accounts live-capable
npm test
node --check src/deals.js
node tools/repair-purchase-ledger.mjs  # read-only proposal
node tools/audit-deal-strategy.mjs --limit=2000  # read-only strategy comparison
```

Premium live actions require `--live-premium` and its own `dryRun: false`.
`start-money.bat` passes only standard `--live`, so it does not activate premium.
Do not start two processes against these account files.

Premium Settings saves are validated and durably queued, then applied between
account activities. A newer save replaces pending values. Jobs survive restarts
and report queued/applying/applied/failed status. Buy-rule edits re-evaluate
pending plans. External config edits require a restart; they can conflict with
queued/tool changes and should not be silently overwritten.

The example also enables `trades.acceptIncoming`. In live/unpaused mode the
engine periodically accepts pending incoming offers addressed to this account
through the site's trade API and records outcomes. This is a separate configured
action loop, not the demand model or auction purchase strategy. Existing files
without trade settings receive `acceptIncoming: false` in memory.

Useful reads include `/api/premium/state`, `/api/premium/deals`,
`/api/premium/history`, `/api/premium/snipe-history` and
`/api/premium/settings`. Verification retry follows a human check completed on
the game site; persistent buying waits prevent further rejected bids.

## Troubleshooting and change boundaries

- Many deals, no bids: inspect lanes, quote rejections, reserve, capacity,
  planning horizon, pause/verification and live mode. Watching is not funding.
- The finite-horizon margin rejection means no tested resale ask leaves a
  positive bid ceiling while meeting the sale-probability requirements. It can
  occur even on a one-coin auction: the quote subtracts slot opportunity cost
  and then requires the greater of the lane's coin margin and profit per
  expected slot-hour. A high first-attempt probability can force such a low
  resale ask that these combined costs consume its proceeds.
- Use `tools/audit-deal-strategy.mjs` against the existing dashboard before
  tuning those requirements. It compares the current profile with several
  illustrative alternatives, including one retaining the 85% retry-horizon
  target. Reads use the same exact-variant quote function, current calibration,
  own outcomes, controlled money-account exclusions and read-only SQLite.
  Results measure economic eligibility at recorded prices, not profitable wins;
  cash, capacity, held variants and final live prices still need the engine's
  checks. The sample is the current watchlist, so it is not a market-wide or
  chronological backtest. The tool never saves settings or contacts the game.
- Purchased card will not list: inspect copy attribution, recorded floor,
  attempts, active/return status and market health before changing prices.
- Ledger mismatch: use durable events and acquisition/return chains. The repair
  tool's `--apply` requires a paused premium checkpoint and stopped money
  dashboard, creates backups and rejects ambiguous evidence. Do not run it as a
  normal diagnostic.
- Thin/fake demand: verify exact variant, distinct participants and controlled
  account exclusion. Aggregate rarity prices are not proof for a specific buy.

Changes to buying or accounting need tests for reserve/capacity at bid time,
uncertain outcomes, restarts, copy remapping, floors, settings changes and
account separation. Preserve existing purchase plans when adjusting future
acquisition filters. Market-derived forecasts remain estimates.
