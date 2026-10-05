# Jarvis Telegram assistant

Jarvis lets approved Telegram users ask about the bots, research the recorded
market and request permitted bot controls. It runs through the viewer's Telegram
service using a local Codex bridge and a fixed set of tools. It is not the
optional scheduled trading strategy agent in `AGENT.md`.

The exact tool catalog and permission/undo contract are in
[../viewer/JARVIS.md](../viewer/JARVIS.md). This guide explains the architecture
for future development chats.

## Request lifecycle

1. Telegram polling receives `/jarvis <request>` or a supported image/question.
2. The notification service checks pairing and the chat's current approval.
   Unapproved users request access from the admin; grants alone are insufficient.
3. Find or create that Telegram chat's persistent Codex conversation. `/jarvis-new`
   starts another conversation while retaining the old one.
4. `CodexAppServer` starts a local `codex app-server --listen stdio://` process
   as needed, sets the restricted tool configuration and sends a turn.
5. The model requests dynamic tools. `JarvisTools` validates arguments and binds
   the request to the real Telegram actor and active turn.
6. Read tools use fixed local bot APIs or isolated read-only market queries.
   Mutation tools recheck approval/grants and current state immediately before
   applying a change, recording the attempt in the change journal.
7. Return the completed answer to Telegram. The conversation persists for the
   next question. Completed mutations remain recorded if a later step fails.

The bridge currently fixes model `gpt-6-luna`, reasoning `high`, a ten-minute
turn limit and at most sixty tool calls. These are implementation constants,
not a claim about which model a future desktop chat will use.

## Approval and resources

The viewer prints a one-time `/jarvis-admin <code>` pairing command locally.
The paired admin can approve, deny and revoke other Telegram chats. Approval
lasts 24 hours and every tool call requires current approval, including an
admin's call.

Approved non-admin users can read. Writing requires a grant for a specific
resource such as `trading:main`, `money:standard` or `money:premium`.
The approved admin can use the permitted controls for all registered resources.
Revocation also removes grants; ordinary approval expiry retains grants, which
become usable only after approval is restored.

Only actual Telegram admin commands manage grants. Model-supplied chat IDs
cannot impersonate another actor. `/jarvis-tools` lists tools and
`/jarvis-permissions` shows access. Notifications/subscriptions have a separate
access path from Jarvis tool approval.

`trading:main` defaults to the root trading dashboard. `JARVIS_TRADING_BOTS`
registers additional stable names mapped to already-running, fixed loopback
HTTP origins. Model arguments cannot introduce a URL, account, file or endpoint.

## What the tools do

| Group | Capabilities and boundaries |
| --- | --- |
| Project context | `jarvis_project_info` reads a fixed allowlist of existing project guides |
| Trading reads | Status, targets/themes, collection, plans, settings/limits, journals and catalog |
| Trading edits | Target/theme changes, validated settings, wishlist, pause/resume, scans and verification retry |
| Market | Card/auction research, exact-variant price statistics and bounded structured reports; read-only |
| Money | Account-specific status/history/quotes/settings; permitted settings, runtime controls and owned-listing cancellation |
| Change history | Inspect successful changes; restore eligible target/theme/settings changes when current state still matches |

Settings tools exclude live activation, identities, ports and hard-limit files.
Engine live flags, cash reserves, stale-model checks and purchased-copy
protections continue to apply. A requested cycle, scan or settings change can
lead to normal live activity; tool execution is not inherently a simulation.
Preview is supported for eligible edits. Undo cannot retract a submitted bid,
sale, recycling action, listing cancellation or runtime control.

Changes are journaled to
`%LOCALAPPDATA%\WikiMastersBot\jarvis-changes.jsonl` with actor/resource,
before/after state, result and change ID. If journaling is unavailable, mutation
is refused. Undo checks for intervening edits and revalidates current limits
and permission.

The project-info allowlist currently reads the root `README.md`, `POLICIES.md`,
`AGENT.md`, analyzer README and money README. The new `docs/` context is linked
from repository entry points for desktop chats; those links do not give Jarvis
arbitrary file-reading access or automatically expand its guide tool.

## Isolation and market reports

The bridge disables general shell, browser, inherited app/plugin, file-image,
web-search and other general-purpose tool surfaces. It uses a read-only command
sandbox with network access disabled and fails closed on inherited external
MCP servers. Approved dynamic tools are executed by the local broker, which
performs the side effects against registered endpoints.

Structured market reports allow approved tables/columns, filters, aggregates,
ordering and bounded rows; they do not expose arbitrary SQL or writes.
`jarvis-market-worker.js` opens SQLite read-only with `query_only`, disabled
extensions, bounded memory/cache and query timeout. At most two reports run
concurrently. Dashboard research reuses the analyzer's existing HTTP readers
and caches. Direct DB reports can work with the analyzer HTTP server down if
the recorded DB remains accessible, but that does not make the data current.

Sale reports must filter finalized `settled_sold` outcomes. Exact prices preserve
rarity/shiny distinctions and expose sparse/stale evidence. Timestamp fields
in reports are epoch milliseconds.

## Source map and verification

| File | Responsibility |
| --- | --- |
| `viewer/telegram-notifications.js` | Pairing/access state, Telegram commands, conversation selection, attachments and message delivery |
| `viewer/codex-app-server.js` | Local process/RPC, restricted tools, threads, active turns and timeouts |
| `viewer/jarvis-tools.js` | Schemas, actor binding, resource registry, permission checks, API dispatch, journaling and undo |
| `viewer/jarvis-market-worker.js` | Isolated SQLite market reports/statistics |
| `viewer/JARVIS.md` | User-facing tools/permissions reference |

Jarvis needs a running viewer with Telegram configured and an available local
Codex executable/login. `CODEX_EXE` can override the executable path. It starts
through Telegram service initialization/use, not a separate package launcher.

From the repository root:

```powershell
node --test viewer/test
node --check viewer/jarvis-tools.js
node --check viewer/codex-app-server.js
```

Tests mock relevant bridge, API and Telegram behavior. Do not trigger a real
Telegram action as a routine permission test. For failures, distinguish access
expiry, missing resource grant, unavailable upstream, stale/conflicting settings,
model timeout and a refused unsafe tool configuration.

When adding tools, preserve fixed destinations, bounded schemas, actor binding,
permission checks immediately before mutation and mandatory journaling. Extend
tests and `viewer/JARVIS.md` with the capability. Do not add general shell or
arbitrary-file access to work around a narrow missing operation.
