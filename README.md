# WikiMasters bot

Autonomous helper for [wiki-masters.com](https://www.wiki-masters.com): snipes auctions by rule, opens packs when they are available, and recycles unwanted cards. Has a local web dashboard.

- **Sniping:** bids land ~11 s before an auction ends (the site extends auctions for bids in the last 10 s). The bot measures the server clock offset and latency, re-checks the auction just before firing, and reports when a bid extended an auction.
- **Rules:** which auctions to bid on and which cards to recycle are plain rules (rarity, wishlist, pageviews, ATK/DEF, regex...). See [POLICIES.md](POLICIES.md).
- **Packs and recycling:** opens packs as they become available and recycles by policy, with a random ~4 s wait before each call.
- **Dashboard:** http://localhost:8787 while the bot runs. Status, upcoming snipes, live log, rule editor, pause button. Local only.
- **Hot reload:** edit `config.json` (or use the dashboard) and it applies within seconds; invalid edits are rejected.

## Setup

Needs Node 20+. No dependencies to install.

1. `cp config.example.json config.json` and adjust the rules and limits.
2. Log in to WikiMasters in a **separate Incognito window**. In DevTools → Network, open any request to `www.wiki-masters.com` and copy the `cookie` request header.
3. Create `.env` (see `.env.example`) with `COOKIE=<that value>` and `SUPABASE_ANON_KEY=<the public anon key the site sends as the apikey header>`.
4. Do not log out of that Incognito login afterwards; the bot renews its own session.

```bash
npm start            # dry run: logs what it would do, changes nothing
npm run live         # bids, opens packs and recycles for real (also needs "dryRun": false)
npm run explain      # what the current rules would do right now (read-only)
npm run check-config # validate config.json
```

## Notes

- Recycling is permanent. It is off in the example config's dry-run mode and only acts with `--live`.
- The bot never tries to bypass human verification; if the site asks for it, pack opening pauses for an hour.
- Use it only where the site's rules allow automation. Keep `.env` and `.session.json` private.
