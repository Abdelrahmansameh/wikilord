# Context for Codex chats

This repository automates several separate accounts in the WikiMasters card game.
Start with [docs/overview.md](docs/overview.md), then read the guide for the part you
are working on. These documents explain the implementation; they do not authorize
live game actions or changes to the owner's strategy.

## Read the relevant guide

| Area | Context guide | Existing reference |
| --- | --- | --- |
| Collecting cards, targets, auction sniping | [Trading bot](docs/trading-bot.md) | [POLICIES.md](POLICIES.md) |
| Recording auctions, SQLite, market dashboard | [Market analyzer](docs/market-analyzer.md) | [market-analyzer/README.md](market-analyzer/README.md) |
| Packs, routine sales, recycling | [Standard money bot](docs/money-bot-standard.md) | [money-bot/README.md](money-bot/README.md) |
| Buying for resale, premium sales, purchase accounting | [Premium money bot](docs/money-bot-premium.md) | [money-bot/README.md](money-bot/README.md) |
| Phone access, proxies, Telegram notifications | [Viewer](docs/viewer.md) | [README.md](README.md) |
| Telegram AI assistant, tools and permissions | [Jarvis](docs/jarvis.md) | [viewer/JARVIS.md](viewer/JARVIS.md) |

`AGENT.md` (singular) is the manual for the optional scheduled trading strategy
agent. Read it, `strategy.md`, and the strategy journal when the task concerns
that agent or the owner's collection strategy. General development chats should
not automatically start its scheduled-run workflow.

## Working in this repository

- Inspect `git status` before edits and preserve existing work. Several components
  may have uncommitted changes. Do not reset, clean, or stage unrelated files.
- Use Node 22.13+ for the full project: the analyzer and money bot use built-in
  SQLite. Each package is private and uses ES modules; the supervisor is CommonJS.
- Standard and premium money accounts run in one process. Do not start another
  money process against their same sessions/checkpoints.
- Treat credentials, personal configuration, targets, journals, databases and
  checkpoints as private runtime data. Do not copy their contents into docs or
  commits. Example configs describe defaults, not the owner's current settings.
- Keep the analyzer as the market database's writer. Pricing and reporting
  consumers use read-only connections. Keep expensive queries away from the
  collector's main thread.
- Preserve live flags, dry-run checks, account separation, bid ceilings, reserves,
  human-verification handling and purchased-card protections when changing code.
- Use the validation commands in the component guide. Do not launch a live bot,
  retry packs, run a trading cycle, or restart an existing process just to check
  a documentation or code edit.
- Update the relevant context guide when changing architecture, state files,
  commands, account boundaries or decision logic.

The guides describe the checked-in/source implementation as reviewed on
2026-10-04. Verify current code and runtime status when a task depends on them;
documentation does not establish which bots are currently running or live.
