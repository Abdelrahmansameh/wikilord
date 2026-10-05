# Viewer and Telegram notifications

The viewer is a local status/proxy service for accessing the bots from a phone.
It combines summaries, forwards dashboard pages to the existing local services,
and optionally runs Telegram alerts and [Jarvis](jarvis.md). It does not start
the trading, analyzer or money processes.

Entry point: `viewer/server.js`. Launcher: root `start-viewer.bat`.
The root [README](../README.md) includes Tailscale setup commands.

## Four surfaces in one process

| Local port | Surface | Reads and changes |
| --- | --- | --- |
| 8790 | Combined status page | Trimmed bot summaries; owner-authorized login-cookie submission |
| 8791 | Analyzer proxy | Analyzer dashboard/data; cookie connection is the permitted write |
| 8792 | Full trading proxy | Existing trading dashboard, including its controls |
| 8793 | Money proxy | Standard and premium dashboards, including their controls |

The default upstreams are loopback ports 8787, 8788 and 8789. `VIEWER_BOT_URL`,
`VIEWER_MARKET_URL` and `VIEWER_MONEY_URL` override them. Viewer port variables
and corresponding Tailscale HTTPS-port variables are defined in `server.js`.

The status page reads state/report/status/overview endpoints and caches one
combined response for about three seconds. Summaries select specific fields,
scrub logs and omit cookies/config. Standard and premium money status are read
separately even though they share an upstream process. A failed upstream is
shown as offline without bringing down the whole status page.

The fuller proxies pass permitted requests through to the upstream services.
Their permissions differ from the trimmed status page: full trading and money
dashboards can perform live operations through the existing bot controls.

## Phone access and permissions

All viewer listeners bind to `127.0.0.1`. Tailscale Serve provides private
tailnet access. The typical mapping is HTTPS default port to 8790, HTTPS 8443
to 8791, HTTPS 8444 to 8792, and HTTPS 8445 to 8793.

Host, method and origin checks constrain incoming requests. Status/market
viewing can be available to tailnet users, subject to `VIEWER_ALLOW`. Remote
login submission and full control dashboards require the owner identity found
with Tailscale status, or the configured `VIEWER_ALLOW` logins. If owner lookup
fails, remote full control stays unavailable until access is configured.

`VIEWER_ALLOW` is a comma-separated list of Tailscale login names. Do not
interpret access to the status page as access to every mutation. Keep the
same-origin and owner restrictions on proxy changes.

## Telegram notification workflow

Set `TELEGRAM_BOT_TOKEN` in the process environment or root `.env` to enable
Telegram. The token stays local. `telegram-notifications.js` polls Telegram and
bot summaries, compares open issues and sends subscribed chats new/recovery
alerts for outages, rejected login and human verification.

Commands include `/status`, `/subscribe` and `/unsubscribe`. Subscription is
distinct from Jarvis approval: receiving alerts does not grant trading powers.
Jarvis approval, grants, admin pairing and conversation routing are covered in
[jarvis.md](jarvis.md) and [../viewer/JARVIS.md](../viewer/JARVIS.md).

Notification/subscription/access state is stored under
`%LOCALAPPDATA%\WikiMastersBot`; it is not a game-account checkpoint.
Telegram image attachments for Jarvis are saved in that folder's `jarvis-media`
subdirectory. They are limited to 20 MB and an uncaptained image can be used by
a subsequent `/jarvis` question within fifteen minutes.

## Source map

| File | Responsibility |
| --- | --- |
| `viewer/server.js` | Upstream summaries, access checks, status/static server and three proxies |
| `viewer/page.html`, `viewer/app.js` | Combined status page, refreshes and rendered bot health |
| `viewer/telegram-notifications.js` | Telegram polling, issue alerts, subscriptions, pairing/access and Jarvis dispatch |
| `viewer/codex-app-server.js` | Local Codex process and assistant conversation/turn bridge |
| `viewer/jarvis-tools.js`, `viewer/jarvis-market-worker.js` | Permission broker and isolated market reporting |
| `viewer/test/` | Notification, bridge and tool permission/behavior tests |

## Run and verify

From the repository root:

```powershell
node viewer/server.js
node --test viewer/test
node --check viewer/server.js
```

Open `http://localhost:8790` for combined status. Read `GET /api/summary` for a
snapshot. Start the relevant bot separately when its card shows offline.
Starting the viewer with a configured Telegram token can send alerts; do not
launch it merely to validate docs or send test messages without authorization.

## Troubleshooting and change boundaries

- Local dashboard works, phone control fails: inspect Tailscale Serve mappings,
  owner discovery and `VIEWER_ALLOW`. Keep host/origin restrictions intact.
- Proxy offline: check the upstream bot and configured URL. The viewer is not a
  supervisor for those bots.
- Alerts absent: inspect token availability, subscriber state and issue changes.
  Jarvis approval does not automatically subscribe a chat to health alerts.
- Jarvis unavailable while status works: inspect the Codex bridge separately;
  ordinary summaries do not require a working assistant turn.

Preserve summary scrubbing, account-specific money routing, same-origin controls
and owner restrictions. Avoid forwarding arbitrary destinations or exposing
credentials through debug status. Telegram messages are external side effects,
so use tests with mocked delivery for notification changes.
