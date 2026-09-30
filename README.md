# WikiMasters bot

Autonomous helper for [wiki-masters.com](https://www.wiki-masters.com): snipes auctions by rule, opens packs when they are available, and recycles unwanted cards. Has a local web dashboard.

- **Sniping:** bids land ~11 s before an auction ends (the site extends auctions for bids in the last 10 s). The bot measures the server clock offset and latency, re-checks the auction just before firing, and reports when a bid extended an auction.
- **Rules:** which auctions to bid on and which cards to recycle are plain rules (rarity, wishlist, pageviews, ATK/DEF, regex...). See [POLICIES.md](POLICIES.md).
- **Packs and recycling:** opens packs as they become available and recycles by policy, with a random ~4 s wait before each call.
- **Dashboard:** http://localhost:8787 while the bot runs. Status, upcoming snipes, live log, rule editor, pause button. Local only.
- **Hot reload:** edit `config.json` (or use the dashboard) and it applies within seconds; invalid edits are rejected.

## Setup

Needs Node 20+. Nothing to install and no files to create.

1. Start the bot: `npm run live` (Windows: double-click `start-bot.bat`).
2. Open **http://localhost:8787**. With no login yet, it opens on the **Connect** tab:
   1. In a **private / Incognito window**, log in to wiki-masters.com/marketplace.
   2. Press F12, open the **Network** tab, press F5.
   3. Right-click the first request → **Copy → Copy as cURL (bash)**.
   4. Paste it into the box on the Connect tab and click **Connect** (the bot finds the login inside it).
   5. Close the private window. Do not click "Log out" there.

The bot checks the login, stores it locally in `.env`, finds the site's public API key by itself, and keeps the session renewed. If the login is ever rejected, a banner on the dashboard asks you to paste a new one. (The site's login is protected by a bot check, so the bot cannot sign in with a password; it never tries to bypass that.)

```bash
npm start            # dry run: logs what it would do, changes nothing
npm run live         # bids, opens packs and recycles for real (also needs "dryRun": false)
npm run explain      # what the current rules would do right now (read-only)
npm run check-config # validate config.json
```

## Going live

The example config is safe by default: `dryRun` is `true` (the bot only logs what it would do) and recycling is off. When the rules look right, use **Settings → Force dry-run** (or set `"dryRun": false`), turn on **Recycle rules → enabled** if you want recycling, and restart.

## Notes

- Recycling is permanent. It is off in the example config and only acts when live.
- The bot never tries to bypass human verification; if the site asks for it, pack opening pauses for an hour.
- Use it only where the site's rules allow automation. Keep `.env` and `.session.json` private.
