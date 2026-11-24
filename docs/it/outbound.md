# Outbound connections

Every host the server itself connects to, what for, and the setting that turns it off. The server sends no telemetry. Every outgoing call is counted by host (never a path, query or body) in **Settings → Network**, which classifies hosts as tracker, Microsoft, GitHub, weather, store or other: use it to check this list against a running server.

This list covers the server only. Browsers and the native apps load the app from the server; links in the app (to an issue on a tracker, for example) open in the user's browser.

## Summary for a firewall

| Purpose | Hosts | Off when |
| --- | --- | --- |
| Trackers and time services | Each connection's own host (see below) | No connection of that type exists; self-hosted hosts are limited by `REMOTE_ALLOWED_HOSTS` |
| Mailbox search (Microsoft Graph) | `login.microsoftonline.com`, `graph.microsoft.com` | `MS_CLIENT_ID` unset (the default) |
| Microsoft Planner connection | `graph.microsoft.com` | No Planner connection |
| GitHub connection | `github.com` (device sign-in, attachments), `api.github.com`, `user-images.githubusercontent.com`, `private-user-images.githubusercontent.com`, `objects.githubusercontent.com` (attachments) | No GitHub connection |
| Module store and licences | The host of `STORE_URL` (default: the inkledger store, see `api/lib/env.ts`) | `STORE_URL=off` |
| Weather for modules | `api.open-meteo.com`, `geocoding-api.open-meteo.com` | `WEATHER=off` |
| Licence timestamp check | The host of `OTS_EXPLORER` (default `blockstream.info`) | Only on an admin's "Verify"; point it at your own Esplora server to keep it inside |
| Local AI (idea suggestions, Desk chat, planner) | The host of `OLLAMA_URL` | `OLLAMA_URL` unset (the default) |
| Forecast sidecar | The host of `FORECAST_URL` | `FORECAST_URL` unset (the default) |
| Alert webhook | The host of the webhook set in Settings → Network | No webhook set (the default); never sent by a read-only server |
| Request traces (OpenTelemetry) | The host of `OTEL_EXPORTER_OTLP_ENDPOINT` | `OTEL_EXPORTER_OTLP_ENDPOINT` unset (the default) |

`PROVIDERS_READ_ONLY=1` does not stop calls to trackers: it refuses every call that could change something on them. `SYNC_INTERVAL_MIN=0` stops the background sync; calls made while users work still go out.

## Trackers and time services

A tracker is only contacted after a user adds a connection to it. Hosted services use a fixed API host; self-hosted ones use the address the user enters. Attachments shown in the app are fetched by the server from the tracker's own host. Two exceptions follow other hosts: Jira Cloud redirects attachment content to Atlassian's media CDN (an HTTPS host it names in a signed redirect, followed without credentials), and GitHub serves files from the `githubusercontent.com` hosts listed below. Other redirects to another origin are refused.

| Service | Host |
| --- | --- |
| Jira (Cloud or Server/Data Center) | The site address entered (e.g. `<site>.atlassian.net`, or your own server); Cloud attachments also from Atlassian's media CDN (by redirect) |
| Tempo | `api.tempo.io` |
| GitHub | `api.github.com`, `github.com`; attachments from `user-images.githubusercontent.com`, `private-user-images.githubusercontent.com`, `objects.githubusercontent.com` |
| GitLab, Gitea, YouTrack, Azure DevOps, Plane, OpenProject, Redmine | The address entered (self-hosted, or the vendor's cloud address) |
| Linear | `api.linear.app` |
| Shortcut | `api.app.shortcut.com` |
| Trello | `api.trello.com` |
| Asana | `app.asana.com` |
| ClickUp | `api.clickup.com` |
| monday.com | `api.monday.com` |
| Notion | `api.notion.com` |
| Wrike | `www.wrike.com` |
| Basecamp | `3.basecampapi.com`, `launchpad.37signals.com` |
| Todoist | `api.todoist.com` |
| Microsoft Planner | `graph.microsoft.com` |
| Harvest | `api.harvestapp.com` |
| Clockify | `api.clockify.me` |
| Toggl Track | `api.track.toggl.com` |
| Everhour | `api.everhour.com` |

Self-hosted addresses: in production, only an admin may connect a host that is not listed in `REMOTE_ALLOWED_HOSTS`; set it to restrict which internal hosts the server may reach. Hosted services are never limited by it. Redirects are checked again before they are followed.

## Microsoft (mailbox search)

Off by default. With `MS_CLIENT_ID` (your own Entra app, see [Outlook](../outlook.md)) and `MS_TENANT`, users may sign in to their mailbox with a device code; the server then calls `login.microsoftonline.com` (sign-in and token refresh) and `graph.microsoft.com` (search, read). Pasting or dropping mails and the Outlook add-in work without it. The add-in is a page Outlook loads from this server; the server makes no call to Outlook for it. `MAIL_COPIES=off` stops storing copies of pinned mails but does not change outbound traffic.

## Module store and licences

`STORE_URL` (default: the inkledger store) is called when someone opens Settings → Store (the catalog, at most every 12 hours, the last copy kept), while a licence request or payment is pending, to download a module package, and to renew licence activations (every 90 days, 30 days of grace). Redirects to other hosts are refused. `STORE_URL=off` turns all of it off; a server that never reaches the internet activates licences with an offline code.

## Weather

Modules that ask for real weather get it through the server from Open-Meteo. Requests carry only coordinates rounded to 0.1° (or a place name for the search), and answers are cached for 30 minutes. `WEATHER=off` turns it off.

## Licence timestamp check

When an admin presses "Verify" on a licence, the server asks a Bitcoin block explorer (Esplora API, `OTS_EXPLORER`, default `https://blockstream.info/api`) for the block the licence's timestamp points to (by its height, then its header). Nothing about the server or the licence is sent. It never runs on its own.

## Local services

`OLLAMA_URL` and `FORECAST_URL` are meant for services on the same machine or private network. A public `OLLAMA_URL` is refused unless `OLLAMA_ALLOW_PUBLIC=1`. Both are off when unset.

## Alert webhook

Off by default. An admin may set a webhook URL in Settings → Network; each alert (a connection that stopped working, a failed backup, a licence not renewed, the HTTPS certificate about to end) is then posted there once per cooldown, signed with HMAC-SHA256. The post holds the alert's text and the name of the connection or licence it is about, never credentials or tracker data. The URL is checked when saved and before each post: no loopback, link-local or metadata addresses, no redirect to another site. A read-only server (`PROVIDERS_READ_ONLY=1`) never posts it.

## Request traces (OpenTelemetry)

Off by default. With `OTEL_EXPORTER_OTLP_ENDPOINT`, the server sends one span per HTTP request (method, route template, status, timing; never a path, query, header or body) to `<endpoint>/v1/traces` over OTLP/HTTP JSON. The endpoint is checked at start like a tracker's address.

## Inbound only (no outbound traffic)

- Tracker webhooks (off by default, per connection) are received, never sent.
- `/api/health`, `/api/ready` and the app itself are served to clients; `/api/metrics` (off unless `METRICS_TOKEN` is set) is scraped by your Prometheus, nothing is pushed.
- Backups are written to `BACKUP_DIR` on the host; nothing is uploaded.
