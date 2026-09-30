# Policies guide

Everything is in [config.json](config.json). **Save the file and the bot applies it within ~3 seconds, no restart.**
If the file has a mistake, the bot keeps the old settings and logs exactly what is wrong.

```bash
npm run check-config   # validate config.json
npm run explain        # show what the current policies would do right now (read-only)
npm run live           # start the bot (bids, packs, recycling for real)
npm start              # start in dry-run: logs what it would do, changes nothing
```

Needs a restart: `dryRun`, `--live`, `timing.pollSeconds`, `timing.recalibrateMinutes`.

## Conditions (`when`) — used by bid rules AND recycle rules

All listed conditions must be true. Leave `when` out to match everything.

| condition | meaning |
|---|---|
| `wishlist: true/false` | card is / is not on your wishlist |
| `rarity: ["C","PC","R","SR","UR","L"]` | any of these rarities |
| `shiny`, `starred`, `tagged`: true/false | shiny, starred, or has a tag |
| `minPageviews` / `maxPageviews` | Wikipedia pageviews |
| `minQScore` / `maxQScore` | quality score |
| `minAtk` / `maxAtk`, `minDef` / `maxDef` | stats |
| `minPrice` / `maxCurrentPrice` | current auction price (bids only) |
| `titleRegex`, `categoryRegex` | case-insensitive regular expressions |

Rules are checked **top to bottom, first match wins**. Put exceptions above general rules.
Add `"enabled": false` to switch a rule off without deleting it.

## Auction policy (`rules`)

```json
{ "name": "wishlist", "when": { "wishlist": true }, "bid": { "max": 9, "increment": 1 } }
{ "name": "never-commons", "when": { "rarity": ["C"] }, "skip": true }
```
- `bid.max`: never bid above this. `bid.increment`: how much above the current price (first bid = starting price).
- `"skip": true`: never bid on matches.
- Cards you own, your own listings, and auctions you already lead are always skipped (`global.skipOwned`).

Safety limits (`global`): `dailySpendCap`, `maxSnipesPerHour`, `reserveBalance` (balance to always keep), `minGapBetweenBidsMs`.

Timing (`timing`): `targetRemainingMs` is when the bid should land before the end (11000 = 11 s, must stay > 10000 or the auction extends). `extraBidLatencyMs` shifts the bid earlier if it lands too late (the log says so when an auction gets extended).

## Recycle policy (`recycle`)

```json
"recycle": {
  "enabled": true,          // false = only report what it would recycle
  "afterPackOpen": true,    // recycle right after opening a pack
  "sweepExisting": true,    // also sweep the whole collection every sweepMinutes
  "default": "keep",        // what happens when no rule matches
  "gapMs": [3500, 5000],    // random wait before EACH recycle call
  "rules": [
    { "name": "keep-wishlist", "when": { "wishlist": true }, "action": "keep" },
    { "name": "recycle-commons", "when": { "rarity": ["C"] }, "action": "recycle" }
  ]
}
```
Recycling is permanent. Cards in a pending trade are always kept. Each recycle pays about +1 balance.

Examples:
- Also recycle weak Peu Communes: `{ "name": "weak-PC", "when": { "rarity": ["PC"], "maxPageviews": 60 }, "action": "recycle" }` (place it before any broad keep rule).
- Keep every card with 5000+ pageviews: `{ "name": "keep-popular", "when": { "minPageviews": 5000 }, "action": "keep" }` (place it first).

## Packs (`packs`)

`enabled`, `checkSeconds` + `jitterSeconds` (how often to look for a free pack), `gapMs` (random wait before each open), `maxPerRun`, `backoffMinutes` (pause after an error). If the site ever asks to verify you're human, pack opening pauses for 1 hour and the bot logs it; it never tries to get past the check.

## Session

The bot keeps itself logged in and renews the session at a random point in each hour. Put your cookie in `.env` once (see `.env.example`); use a separate Incognito login for it, and do not log out of that login.
