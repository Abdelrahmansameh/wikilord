# Standard money bot

The standard money account opens free packs and chooses which inventory cards
deserve the game's limited selling slots. It prices listings using observed
market demand, keeps uncertain opportunities queued or explores them, and
recycles cards with weak sale prospects. It does not run the premium acquisition
engine and does not follow the root trading bot's themed collection targets.

Entry point: `money-bot/src/main.js`. Dashboard: `http://localhost:8789/`.
The same process also hosts the [premium account](money-bot-premium.md).
Read [../money-bot/README.md](../money-bot/README.md) for the combined operations
reference.

## How a cycle works

The example cycle interval is three minutes. An account cycle is serialized so
inventory decisions do not race with another cycle for that account.

1. Check pause/login and reject an account identity used by another bot.
2. Refresh the shared market model when due. Require settled history no older
   than `maxMarketAgeHours`, default 24 hours. A missing/stale model stops the
   cycle before ordinary pack/inventory actions.
3. Read balance, pack availability, owned listings and inventory. Reconcile
   completed auctions and returned cards with the checkpoint and event history.
4. Quote eligible copies. Exclude already listed/unresolved cards and copies
   involved in pending trades. Refuse inventory decisions from a partial scan.
5. Update observed arrival rates and listing-slot usage, then compute a slot
   cutoff: the expected value needed to justify occupying a scarce slot.
6. Rank routine and exploratory listings. In dry-run, expose what would be
   listed/recycled and record local accounting without game mutations.
7. In live mode, perform the eligible account activities: pack opening, optional
   replacement of a weak listing, filling free slots and recycling weak cards.
   Respect action budgets, pauses, verification waits and randomized spacing.
8. Refresh listing/balance state and save accounting. Errors and failed discards
   enter durable history and can be retried later.

At most five one-hour listings are supported. Replacement has configurable
minimum gain and ratio checks; cancellation/ownership/bid checks still apply.

## Pricing and slot decisions

The shared worker model reads completed sold **and unsold** auctions. It builds
sale-probability/proceeds curves for proposed asking prices, using variant
evidence and broader model features. Repeated asks are handled as related
evidence, not automatically independent observations. A recorded average sale
price alone does not capture whether a listing is likely to sell.

Useful quote fields are:

| Field | Meaning |
| --- | --- |
| `p` | Estimated probability of sale at the ask |
| `meanProceeds` | Estimated proceeds conditional on a sale |
| `mu` | Expected gain over recycling, before uncertainty penalties |
| `L` | Conservative gain with outcome and model uncertainty penalties |
| `U` | More optimistic gain, still adjusted for outcome uncertainty |
| `cutoff.value` | Minimum gain justified by current slot scarcity |

The basic expected-gain calculation is
`mu = p * (meanProceeds - recycleValue) - listingFee`.
The code applies separate outcome/model penalties to form `L` and `U`.
These are decision scores from a model, not guaranteed proceeds.

Routine candidates need sufficient independent evidence and conservative gain
above the cutoff. The default sale-probability target is 0.8; a useful positive
fallback can still be selected with the missed target explicitly reported.
Exploratory listings use plausible upside when routine evidence is thin. The
selector can preserve an exploration opportunity when its upside exceeds the
weakest new routine choice; it can fill other spare slots with trials too.

The cutoff remains zero during a cold start or when arrivals fit within listing
capacity. It rises when valuable arrivals outpace observed/theoretical slot
turnover. This makes recycling and queue decisions depend on the account's
recent workload as well as market prices.

The current classifier recycles variants with zero recorded sales unless rarity
is UR or L, and can recycle when even optimistic gain does not clear the cutoff.
An unsold listing feeds new evidence into future quotes and can restrict the
next ask. Do not describe the policy as simply “sell rare cards, recycle commons.”

## Source and state map

All source paths below are under `money-bot/`.

| File | Responsibility |
| --- | --- |
| `src/main.js` | Starts both accounts, their sessions/stores and one shared model |
| `src/engine.js` | Cycle, inventory quotes, slots, packs, listings, recycling, reconciliation and accounting |
| `src/model.js` | Worker-side SQLite reads and pricing/probability calculations |
| `src/shared-model.js` | One lazy model build and coalesced refreshes for both accounts |
| `src/config.js` | Config validation and operational-settings boundaries |
| `src/session.js` | Account-local authentication and renewal |
| `src/state.js` | Checkpoint persistence, history paging and account archives |
| `src/verification.js` | Detect site human-verification responses |
| `src/server.js`, `src/ui.html` | Account routing, controls, inspection and standard dashboard |

Standard account files are `money-bot/config.json`, `.env`, `.session.json`,
`state.json` and `events.jsonl`. The checkpoint preserves counters, inventory/
listing attribution, arrivals, pause state and accounting. The JSONL journal is
durable action history, not a replaceable console log.

The model reads `../market-analyzer/market.db` by default. `WM_MARKET_DB` can
override it; otherwise standard and premium configs must resolve to the same
DB. The model never writes the analyzer's database. Its first build on a large
history can take minutes. Do not create a second money process to bypass it.

## Running, settings and verification

From `money-bot/`, using Node 22.13+:

```powershell
npm start             # standard and premium dry-run
npm run live          # only standard is live-capable
npm test              # account, model, engine, dashboard and ledger tests
node --check src/engine.js
```

Standard live actions require `--live` **and** standard `config.json` with
`dryRun: false`. `start-money.bat` passes `--live`, not `--live-premium`.
On first start missing account configs are copied from their example files.
External config edits require a process restart to load; this engine does not
have the root trading bot's file watcher. API settings updates use validation
and account activity checks.

Useful read endpoints are `/api/state`, `/api/history`, `/api/settings`,
`/api/auctions` and `/api/examples`. `/api/run`, pause/resume and verification
retry are controls; a requested cycle can produce ordinary live account actions.

After completing a human check on WikiMasters, use the dashboard's verification
retry. A retry is an operational action, not a way to bypass a challenge. Pack
and inventory error notices should be inspected alongside durable history.

## Troubleshooting and change boundaries

- Inventory waiting: check market age/model initialization, pause/login, slot
  count, failed quotes and cutoff. Queueing does not always mean an error.
- Unexpected recycling: inspect exact variant sales, `L`/`U`, cutoff and quote
  evidence. Rarity alone does not determine the decision.
- Balance differs from reported profit: inspect listing outcomes, recycle
  income, starting balance and unexplained accounting delta. Coin balance
  changes and strategy profit are different measurements.
- Repeated failed discard: inspect site response and retry events; do not count
  a failed mutation as successful revenue.

`engine.js`, `model.js`, `state.js` and `server.js` serve both money accounts.
Changes to routine pricing or persistence need to preserve premium purchased
copy protections and account isolation. Use focused tests before the package's
full suite when altering these shared paths.
