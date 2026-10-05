# Jarvis tools

Use ordinary Telegram requests: `/jarvis Show my targets`, `/jarvis Change this card's maximum bid to 80`, or `/jarvis Search the analyzer for Zelda and show its recorded sales`. Luna uses high reasoning. A request has a ten-minute limit and at most 60 tool calls. Completed actions remain recorded if a later step fails or times out.

## Access

Current Telegram approval is required for every tool call, including an admin's call. Approval lasts 24 hours. The paired admin can control the permitted actions on all registered bots. Other approved users can read bot/market data; they cannot write until the admin grants a specific resource.

- `/jarvis-tools`: show capabilities.
- `/jarvis-permissions`: show resources and your read/write access.
- `/jarvis-grant <chat_id> trading:main`: let an approved chat control that trading bot.
- `/jarvis-grant <chat_id> money:standard` or `money:premium`: grant one money account.
- `/jarvis-ungrant <chat_id> <resource>`: remove that resource's write access immediately.
- `/revoke <chat_id>`: revoke Jarvis approval and remove all resource grants.

The bridge binds tool requests to the actual Telegram chat and checks approval, grants and active-turn state again immediately before each mutation. A model cannot supply a different chat ID or elevate its role. Only the Telegram admin commands can change grants. A temporary approval expiry retains grants, but those grants do nothing until access is approved again.

## Trading

- `jarvis_bots`: registered bots/accounts and permissions.
- `jarvis_trading_read`: status, targets, themes, collection, upcoming plans, settings, limits, journal and card history.
- `jarvis_trading_catalog`: resolve cards by title/category/rarity through the game's catalog.
- `jarvis_targets_change`: add/update/remove targets, set prices/priorities/themes/expiry/counterbids, enable/disable, bulk edits, and create/update/remove themes. Maximum 100 operations per request; hard bid/theme limits apply.
- `jarvis_theme_rename`: move a theme and its targets to a new unused name.
- `jarvis_target_prices`: compare selected targets against exact rarity/shiny sale statistics and optionally apply a percentile-based price. Defaults to preview; at most 30 targets; at least four observations; sales older than seven days do not drive automatic repricing.
- `jarvis_trading_settings_change`: edit operational settings and bid/sell/recycle rule arrays. Reads the current version, validates the replacement and refuses concurrent changes. Ports, identities, live activation and hard-limit files are outside its scope. Owned-card protection cannot be disabled.
- `jarvis_trading_control`: pause/resume, request an auction or wishlist scan, retry packs after completing verification.
- `jarvis_wishlist_change`: add/remove a specified card.

Removing a target cannot retract a bid already sent. Pausing cannot undo past game actions. Some trading timing changes take effect only after the next process restart, as documented in POLICIES.md. Jarvis does not automatically restart a trading bot when saving settings.

The default registered trading resource is `trading:main`, at `VIEWER_BOT_URL` or `http://127.0.0.1:8787`. Register additional running trading instances using `JARVIS_TRADING_BOTS`, a JSON object mapping stable names to their actual local dashboard origins. Connections must be fixed loopback HTTP origins; model arguments cannot add a destination, path or account. Registering two names for the same process does not create a second account.

## Market analyzer (read-only)

- `jarvis_market_read`: the dashboard's card search/details, auction search/details/bids, comparable sales, rankings, players, categories, overview, price tables, timing and health.
- `jarvis_market_prices`: exact card/rarity/shiny statistics, weighted exact median/quartiles, min/max, latest five sale prices, observation count, sparse/stale flags.
- `jarvis_market_query`: structured reports from approved columns in auctions, cards, bids or users, with scalar filters, grouping, count/sum/average/min/max, minimum observations, ordering and up to 100 rows. For realized sale reports, filter `final = 1` and `status = settled_sold`.

The query worker uses a read-only SQLite connection with `query_only`, disabled extensions, bounded cache/memory and a 30-second timeout. No user SQL, joins, table attachments or writes are exposed. At most two reports run concurrently; the collector's thread and writer are unaffected. Dashboard lookups reuse the analyzer's existing reader workers and caches. Database reports can work while the analyzer's HTTP dashboard is unavailable, provided the recorded database is accessible. Report times are epoch milliseconds; active listings and prices are recorded observations, not a guarantee of the current game state.

## Money accounts

- `jarvis_money_read`: select `standard` or `premium` and read status, active listings, price decisions/quotes, lifetime accounting/profit, durable history, settings, listing details, premium deals and snipe history.
- `jarvis_money_settings_change`: validated operational settings for the selected account. Includes pack/listing settings and premium pricing/buying/trade settings. Use `buy.enabled` to switch premium buying on/off. Preview does not save or run a cycle. Ports, database paths, account switching and live activation are excluded.
- `jarvis_money_control`: pause/resume one account, retry packs or request a normal cycle.
- `jarvis_money_remove_listing`: cancel a specific owned listing through existing bid/ownership checks.

The existing live flags, dry-run state, cash reserves, stale-market checks, account separation and purchased-card protections remain enforced by the engines. A normal cycle or a settings update can trigger ordinary live bot activity. Pack retry is for a human check already completed on WikiMasters. Jarvis cannot bypass verification. An externally edited money config must be loaded by restarting its process before tool settings changes can proceed.

## Changes and undo

Target/theme and settings tools accept `preview: true`; read-only chats can inspect previews. Routine changes requested by an authorized user can apply directly. Every attempted mutation is recorded under `%LOCALAPPDATA%\WikiMastersBot\jarvis-changes.jsonl` with a change ID, actor, resource, reason, before/after state and result. If the journal cannot be written, the action is refused.

`jarvis_changes` reads successful changes (admin: all; other users: their own). `jarvis_undo_change` can restore target/theme or settings changes only when the current state still matches that action's result and current permissions/hard limits allow the restoration. It refuses conflicting later edits. Large target restores may need explicit edits if they exceed the 100-operation limit. Bids, sales, recycling, listing cancellations and runtime controls cannot be undone by this tool.

Jarvis's general shell, browser, image-file reader and inherited app/plugin tools are disabled, and its command sandbox remains read-only with network access disabled. Tool side effects are executed only by this broker against the registered local bot endpoints. The bridge fails closed if a thread inherits an external MCP server. Fixed project guides are available through `jarvis_project_info`; credentials and arbitrary files are not exposed.
