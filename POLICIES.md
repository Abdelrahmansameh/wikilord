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
| `titleContains` | title contains this text, ignoring accents and case (e.g. `mathématiques`). The bot also **searches the marketplace for it**, so matching auctions are found however far away they end |
| `titleRegex`, `categoryRegex` | case-insensitive regular expressions |

Rules are checked **top to bottom, first match wins**. Put exceptions above general rules.
Add `"enabled": false` to switch a rule off without deleting it.

## Auction policy (`rules`)

```json
{ "name": "wishlist", "when": { "wishlist": true }, "bid": { "max": 9, "increment": 1 } }
{ "name": "never-commons", "when": { "rarity": ["C"] }, "skip": true }
```
- `bid.max`: never bid above this. `bid.increment`: how much above the current price (first bid = starting price). The site requires each bid to be at least **10% above the current price, rounded up, and at least +1** (price 20 needs 22); the bot always bids at least that. If the server still says "too low", the bot immediately retries at the minimum it names, as long as your `max` allows.
- `"skip": true`: never bid on matches.
- `"search": "jeu vidéo"`: also search the marketplace for this text every scan. The site's search covers titles **and categories**, so a category rule with a matching `search` finds auctions however far away they end (e.g. `{ "name": "jeux-video", "search": "jeu vidéo", "when": { "categoryRegex": "jeux? vidéo" }, "bid": { "max": 50 } }`). Only results that match the rule's conditions are used.
- Cards you own, your own listings, and auctions you already lead are always skipped (`global.skipOwned`).

**Outbid = new snipe.** After our snipe the bot follows that auction. If someone bids after us and the rules still allow the new price, it queues another snipe: at the normal 11 s before the new end if that moment is still ahead, otherwise `timing.counterRemainingMs` (default 3.5 s) before the end, which extends the auction again. `global.counters` (default 2) caps how many times per auction; a rule can override it with `bid.counters` (0 = never). Counters obey the price max, the daily cap, the hourly limit and the balance reserve. The log shows `someone bid ... after us`, `COUNTER queued`, and every time an outbid moved the end time (`end time moved +Ns`), so you can see how the site's extension works.

Safety limits (`global`): `dailySpendCap`, `maxSnipesPerHour`, `reserveBalance` (balance to always keep), `minGapBetweenBidsMs`.

Timing (`timing`): `targetRemainingMs` is when the bid should land before the end (11000 = 11 s, must stay > 10000 or the auction extends). `extraBidLatencyMs` shifts the bid earlier if it lands too late (the log says so when an auction gets extended).

## Selling policy (`sell`)

Sells cards by rules, like recycling but with action `sell` or `keep`. **Off by default**: turn on `sell.enabled` (Sell rules tab) when the rules suit you.

- **Highest price first.** The bot prices every card that matches a sell rule and lists the ones with the highest price, up to the site's limit of 5 listings at a time (`sell.maxListings`, it counts the listings you already have).
- **Price = a share of the average sale price.** The site shows an average sale price for a card at each rarity when you sell it; the bot reads the same figure and lists at `sell.priceFactor` of it (`0.75` = 75%, rounded). A rule can override it with its own `priceFactor`.
- Cards with **no sales history** at their rarity are skipped unless you set `sell.noDataPrice` (a fixed list price). Nothing is listed below `sell.minListPrice`.
- `sell.durationMinutes` is the listing length: 10, 30, 60, 180, 360 or 720 (a rule can override it).
- A card that is up for sale is **never recycled**, and cards in a pending trade are never sold.
- The bot checks every `sell.checkMinutes` (randomised a little). Sales are counted on the dashboard ("Earned (sales)").
- Default rules: keep wishlist, shiny, starred and tagged cards; sell `L`, `UR` and `SR`.
- Not automated (yet): cancelling or re-pricing your existing listings. The site itself lowers the start price of listings that don't sell.

```json
"sell": { "enabled": true, "priceFactor": 0.75, "durationMinutes": 60, "minListPrice": 5,
  "rules": [
    { "name": "keep-wishlist", "when": { "wishlist": true }, "action": "keep" },
    { "name": "sell-good-cards", "when": { "rarity": ["UR", "SR"] }, "action": "sell", "priceFactor": 0.8 }
  ] }
```

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
Recycling is permanent. Cards in a pending trade are always kept. `"keepIfWorthAtLeast": 20` keeps any card whose average sale price is 20 or more (checked right before recycling), since recycling only pays about 1. Each recycle pays about +1 balance.

Examples:
- Also recycle weak Peu Communes: `{ "name": "weak-PC", "when": { "rarity": ["PC"], "maxPageviews": 60 }, "action": "recycle" }` (place it before any broad keep rule).
- Keep every card with 5000+ pageviews: `{ "name": "keep-popular", "when": { "minPageviews": 5000 }, "action": "keep" }` (place it first).

## Packs (`packs`)

`enabled`, `checkSeconds` + `jitterSeconds` (how often to look for a free pack), `gapMs` (random wait before each open), `maxPerRun`, `backoffMinutes` (pause after an error). If the site ever asks to verify you're human, pack opening pauses for 1 hour and the bot logs it; it never tries to get past the check.

## Session

Log in through the dashboard's **Connect** tab (steps are on the page). The bot keeps itself logged in and renews the session at a random point in each hour. Use a private/Incognito login for it and do not log out of that login. If the site rejects the login, the dashboard shows a banner; paste a fresh cookie on the Connect tab.
