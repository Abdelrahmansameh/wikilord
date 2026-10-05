# WikiMasters bot

## Project context for future chats

Start with the [project overview](docs/overview.md). Detailed context guides cover
the [trading bot](docs/trading-bot.md), [market analyzer](docs/market-analyzer.md),
[standard money bot](docs/money-bot-standard.md),
[premium money bot](docs/money-bot-premium.md), [viewer](docs/viewer.md), and
[Jarvis](docs/jarvis.md). [AGENTS.md](AGENTS.md) gives future Codex chats an entry
point and repository working guidance.

Autonomous helper for [wiki-masters.com](https://www.wiki-masters.com): snipes auctions by rule, opens packs when they are available, and recycles unwanted cards. Has a local web dashboard.

Use Node 22.13 or newer to run the complete project, including the analyzer and money bot. The trading bot alone supports Node 20 or newer.

The standalone [money bot](money-bot/README.md) runs separate standard and premium accounts in one process. Both open packs, price cards from the market analyzer's auction history, fill five sale slots, and recycle weaker opportunities; premium also buys cards for resale. Its dashboard runs on http://localhost:8789 and both accounts default to dry run.

- **Sniping:** bids aim to land at a configurable lead before an auction ends, 15 s in the example config (the site extends auctions for bids in the last 10 s). The bot measures the server clock offset and latency, re-checks the auction just before firing, and reports when a bid extended an auction.
- **Rules:** which auctions to bid on and which cards to recycle are plain rules (rarity, wishlist, pageviews, ATK/DEF, regex...). See [POLICIES.md](POLICIES.md).
- **Selling:** lists your best cards (highest expected price first, up to the site's 5 listings) at a configurable share, default 75%, of their average sale price. Off until you enable it.
- **Packs and recycling:** opens packs as they become available and recycles by policy, with a random ~4 s wait before each call.
- **Dashboard:** http://localhost:8787 while the bot runs. Status, upcoming snipes, live log, rule editor, pause button. Local only.
- **Hot reload:** edit `config.json` (or use the dashboard) and it applies within seconds; invalid edits are rejected.

## Setup

Use Node 22.13+ for the full project; the trading bot alone supports Node 20+. Nothing to install and no files to create.

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
npm run agent -- help # find cards for a theme, manage targets (see AGENT.md)
```

## Going live

The example config is safe by default: `dryRun` is `true` (the bot only logs what it would do) and recycling is off. When the rules look right, use **Settings → Force dry-run** (or set `"dryRun": false`), turn on **Recycle rules → enabled** if you want recycling, and restart.

## Targets and the optional agent

The **Targets** tab lets you list specific cards with a priority and a max bid, grouped in themes with weekly budgets (see [POLICIES.md](POLICIES.md#targets-targets-tab-targetsjson)). `limits.json` holds hard ceilings on every bid.

On top of that, a Claude agent can run on a schedule and manage targets, themes, budgets and settings for you from a strategy you write in plain words. It is optional: the bot never depends on it, and if the agent stops running, the bot keeps following the last settings.

- `strategy.md`: what you want (copy `strategy.example.md`). The agent reads it on every run.
- [AGENT.md](AGENT.md): the agent's manual.
- `npm run agent -- help`: the agent's commands (also handy by hand: `find`, `market`, `prices`, `status`...).
- Every change (yours from the dashboard, or the agent's) is recorded in `journal.jsonl` and shown on the Targets tab.

## Checking from your phone

`start-viewer.bat` runs a small status page for both the bot and the market analyzer on http://localhost:8790. It reads a few things from the two dashboards and passes on a trimmed copy (no cookies, no settings). The only thing it can change is a bot's login: it has a box to paste a new cookie, which goes to the bot's own Connect check. For everything else there is the full dashboard below.

It also serves a read-only copy of the market analyzer's dashboard (all the tabs and charts) on http://localhost:8791, linked from the status page. That copy passes the analyzer's page and data through unchanged; the cookie forms on its Collector tab are the only thing that can be sent back.

And it serves the bot's **full** dashboard, with every control, on http://localhost:8792, also linked from the status page. The bot itself still only answers on this PC; the viewer passes requests on to it.

The viewer also serves the standard and premium money-bot dashboards, with their controls, on http://localhost:8793. The money bot itself still runs on this PC; the viewer passes requests on to it.

Through Tailscale, the full dashboard and the cookie boxes only work for the owner of this PC's Tailscale account (read from `tailscale status` when the viewer starts; `VIEWER_ALLOW` overrides it), so a device or person you share the PC with can't use them. Changes must come from the pages themselves (same origin), so another website can't send them through your browser.

The viewer can also send Telegram alerts when a bot needs a login cookie or human verification, goes offline, or recovers. Add `TELEGRAM_BOT_TOKEN=<token>` to the root `.env`, restart `start-viewer.bat`, then open the Telegram bot. Send `/status` for a snapshot, `/subscribe` to receive alerts, or `/unsubscribe` to stop. Anyone can opt in; subscriber IDs are stored locally under `%LOCALAPPDATA%\WikiMastersBot`.

Approved Telegram users can use GPT-6 Luna with **high reasoning** through `/jarvis <request>`. Jarvis has a fixed set of tools for trading targets/themes/settings, read-only market research and database reports, and standard/premium money-bot controls. The admin can use the permitted controls on every registered bot/account; other approved chats are read-only unless granted a specific resource. `/jarvis-tools` lists capabilities, `/jarvis-permissions` lists access, and `/jarvis-grant <chat_id> <resource>` or `/jarvis-ungrant <chat_id> <resource>` manages write access. [Jarvis tools and limits](viewer/JARVIS.md) documents the tool list, named bots, previews and undo.

The first time, the viewer prints a one-time `/jarvis-admin <code>` pairing command in its local console; send it to the bot to become the admin. Other users request access by sending `/jarvis <question>`. The admin receives their chat ID and can `/approve <chat_id>`, `/deny <chat_id>`, or `/revoke <chat_id>`. Each approval lasts 24 hours; a later `/jarvis` request asks the admin to approve access again. Explicit revocation also removes bot grants. Jarvis keeps one persistent Codex conversation per approved Telegram chat, named with the user's Telegram name. Existing conversations are automatically upgraded for the tool interface with their recent context; the old conversation is retained. `/jarvis-new` starts fresh while leaving the old conversation in Codex. Users can attach an image with a caption, or send an image first and `/jarvis <question>` within 15 minutes. Images are saved under `%LOCALAPPDATA%\WikiMastersBot\jarvis-media` and limited to 20 MB.

To open it from your phone anywhere, use Tailscale (free): install it on the PC and the phone, sign in to the same account on both, then once on the PC:

```
tailscale serve --bg 8790
tailscale serve --bg --https=8443 8791
tailscale serve --bg --https=8444 8792
tailscale serve --bg --https=8445 8793
```

`tailscale serve status` shows the addresses: the status page at `https://<pc-name>.<tailnet>.ts.net`, the market analyzer at `:8443`, the full trading dashboard at `:8444`, and the money bot dashboard at `:8445`. Only devices signed in to your tailnet can open it; nothing is published to the internet (that would be `tailscale funnel`, don't use it). `tailscale serve --https=<port> off` removes one; `tailscale serve reset` removes them all. To limit it to specific Tailscale logins, set `VIEWER_ALLOW=you@example.com` before starting the viewer. The PC has to be awake.

## Notes

- Recycling is permanent. It is off in the example config and only acts when live.
- The bot never tries to bypass human verification; if the site asks for it, pack opening pauses for an hour.
- Use it only where the site's rules allow automation. Keep `.env` and `.session.json` private.
