# Self-hosting inkledger

Everything an operator needs beyond the [README](../README.md) quick start: the first sign-in, updates and releases, HTTPS, configuration and development.

## First sign-in

Open http://127.0.0.1:47823 and sign in as **admin**. Its first password is `INKLEDGER_ADMIN_PASSWORD` if you set one; otherwise the server makes a random one at the first start and writes it to a file only the server can read: `docker exec inkledger cat /app/data/initial-admin-password`. You must choose a new password first (the file goes then). Then:

- connect your trackers in **Settings → Connections**: Jira with its login (for Server / Data Center your Jira URL, username and password, or a Personal Access Token, Data Center 8.14+, recommended; for Cloud your site URL, Atlassian email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens)), GitHub with a code on github.com, the others with a personal token (and your server's address for a self-hosted one);
- invite the others from **Settings → Users**: each gets a one-time link (or a QR code) to choose their password.

Upgrading a server from before local accounts: everyone keeps their data, and activates their account from the sign-in page ("Activate your account") with the login of any tracker they had connected, choosing a username and password. Locked out? `docker exec inkledger node dist/cli.js reset-password <username>` prints a temporary password.

Migrations run at start. Backups are scheduled from **Settings → Backup** and land in `~/Backups/inkledger` on the host (`INKLEDGER_BACKUP_DIR` to change it). The container restarts with Docker (`restart: unless-stopped`).

## Local stack updates and CI deployment

`deploy/staging.yml` runs the local stack on `http://127.0.0.1:47824`, beside the legacy `jtt` stack. `pnpm docker:update` dumps its database, builds the current checkout, swaps only the app container and rolls back the image and database if the health check fails. Use `pnpm docker:update --dry-run` to inspect the operation or `--rehearse-rollback` to test recovery.

Releases and deployment run **only on version tags**, never on a push or merge to `main`. Set the version in `package.json`, commit it, then tag that exact commit (`v1.2.3` for version `1.2.3`) and push the tag. CI rejects a tag that does not match the package version.

A successful tag run publishes:

- `ghcr.io/inkledger/inkledger:vX.Y.Z` and `latest`, for both `linux/amd64` and `linux/arm64`;
- a GitHub Release containing the macOS `.dmg`, Windows NSIS `.exe` and SHA-256 checksums;
- the local production update, using the published image digest after every check and artifact build passes.

No Docker Hub account is needed. After the first publication, make the GHCR package public in its GitHub package settings for anonymous downloads. While it is private, add a GitHub PAT with only `read:packages` as the `GHCR_READ_TOKEN` Actions secret so the deployment runner can pull it.

The `deploy` job requires:

- a runner registered for this repository on the Docker host, with the custom label `inkledger` and access to Docker;
- a GitHub `production` environment and an Actions variable `INKLEDGER_ENV_FILE` containing the absolute path of `.env.inkledger` outside the runner checkout;
- the backup directory in `INKLEDGER_BACKUP_DIR`, or its default `~/Backups/inkledger`.

Only tag workflows reach this runner; pull requests run on GitHub-hosted runners. Production deployments are serialized and are not cancelled by another release. The previous image and database dump remain available for recovery.

## HTTPS and the certificate

The container answers on `https://<name>:3443` by itself, on this machine and on the local network: nothing else has to run. The certificate comes from a small certificate authority (CA) of your own, made once on the Docker host.

| File | Where | What it is |
| --- | --- | --- |
| `ca.crt` | `data/https/` | The public CA certificate. This is what other machines install to trust the server |
| `ca.key` | `data/https/` | The CA's private key. It stays on this machine and never enters the container |
| `server.crt`, `server.key` | `data/https/`, copied to `~/.inkledger/tls/` | The server's certificate. The container reads the copy, mounted read-only on `/app/tls` |

**Never copy or share `ca.key`.** The CA has no limit on the names it can sign, so whoever holds this key can impersonate any website to every machine that trusts your CA. `data/` is gitignored and not part of the image; include it in your own encrypted backups.

**First time**

```sh
pnpm https cert                     # makes the CA and the certificate, and the container's copy
docker restart inkledger            # a stack already running picks it up (a new one finds it at start)
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain data/https/ca.crt   # trust the CA on this Mac, once
```

Then restart the browser and open `https://localhost:3443`. The container's log says `HTTPS on port 3443`.

**Trusting it from other machines:** copy `data/https/ca.crt` there (only the `.crt`) and install it once per machine.

- Windows: from an administrator prompt, `certutil -addstore -f Root ca.crt`.
- macOS: the `security add-trusted-cert` line above.
- Then restart the browser.

**Adding a name or an address.** Two separate lists, and both must hold it:

1. *The certificate.* Add it to `HTTPS_NAMES` in `.env` (comma-separated), run `pnpm https cert`, then `docker restart inkledger`. The CA does not change, so no machine has to trust anything again.
2. *The names the server answers to.* For a DNS name: Settings → Devices → Names on your network, effective at once. For an IP address: add it to `ALLOWED_HOSTS` in `.env.inkledger`, then recreate the container with `docker compose -p inkledger -f deploy/staging.yml up -d --no-deps --no-build inkledger` (a restart does not re-read that file).

**Expiry.** The server certificate lasts 397 days, the longest browsers accept. The CA lasts 825 days. From 30 days before the end, each start of the container logs a warning.

```sh
openssl x509 -in data/https/server.crt -noout -enddate   # the server certificate
openssl x509 -in data/https/ca.crt -noout -enddate       # the CA
```

- **To renew the server certificate:** `pnpm https cert`, then `docker restart inkledger`. Nothing to do on the other machines.
- **To renew the CA:** a certificate cannot outlast its CA, so do this before a renewal would cross the CA's end date. Delete `data/https/ca.crt` and `data/https/ca.key`, run `pnpm https cert`, `docker restart inkledger`, then install the new `ca.crt` on every machine again.

**Using a certificate from your organization** instead of the local CA: put it in `~/.inkledger/tls/` as `server.crt` (with its intermediates) and `server.key`, then `docker restart inkledger`. Don't run `pnpm https cert` afterwards: it would overwrite them.

**File permissions and other locations.** The key must be readable by the container's user (uid 1000). `pnpm https cert` sets it to mode 0640 in a folder other accounts cannot enter, which is enough with Colima on macOS. On a Linux Docker host, make it readable by uid 1000, for example with `sudo chown 1000 ~/.inkledger/tls/server.key`. To keep the files elsewhere, set the environment variable `INKLEDGER_TLS_DIR` in the shell (or in the CI deploy job) when running both `pnpm https cert` and `pnpm docker:update`. In `.env` it would not reach Docker Compose.

| What you see | Cause | What to do |
| --- | --- | --- |
| "Your connection is not private" | The CA isn't installed on that machine, or the name isn't in the certificate | Install `ca.crt`; or add the name (step 1 above) |
| "Misdirected Request" (421) | The server doesn't answer to that name | Add the name (step 2 above) |
| Empty response or connection closed | `http://` on the HTTPS port | Use `https://` |
| `HTTPS off: no certificate in /app/tls` in the log | No `pnpm https cert` yet, or a different folder | Run it, then restart the container |
| `HTTPS off: cannot read the certificate` in the log | The key isn't readable by uid 1000 | See file permissions above |
| Nothing answers on `:3443` | An old `pnpm https agent` holds the port | `pnpm https agent-remove`, then `docker restart inkledger` |

More on the certificate tooling and on HTTPS for the dev server: [https.md](https.md).

## Moving real data from development

Do this once, not after every deployment. Stop `pnpm dev` first so no new work is written after the dump. Keep the Docker stack read-only towards trackers until the imported data and connections have been checked.

Dev's sealed values (tracker credentials, webhook secrets, mailbox sign-ins, mail copies, idea pictures) must open on the Docker stack. If dev has an explicit `CREDENTIALS_KEY`, temporarily set `CREDENTIALS_KEY_OLD` in `.env.inkledger` to it. If dev has none, its values are sealed with a key derived from dev's `SESSION_SECRET`, and giving that secret as `CREDENTIALS_KEY_OLD` is not a reliable substitute: a 64-hex value (as `openssl rand -hex 32` makes) is read there as a raw key, so it opens only the oldest unbound connection secrets. Give dev a `CREDENTIALS_KEY` first instead: set it in `.env`, restart dev, run `pnpm exec tsx api/cli.ts reseal --apply` and check that `pnpm exec tsx api/cli.ts keys-status` shows nothing left on `SESSION_SECRET`; then use that key as `CREDENTIALS_KEY_OLD`. At boot the Docker stack seals the imported tracker credentials again with its own `CREDENTIALS_KEY`; run `docker exec inkledger node dist/cli.js reseal --apply` for the other columns, and remove `CREDENTIALS_KEY_OLD` once `keys-status` shows nothing needs it ([key rotation](it/runbook-rotation.md)).

```bash
pnpm docker:from-dev --dry-run
pnpm docker:from-dev --yes
```

The command dumps both databases before changing anything, imports dev's Postgres database and installed modules, and restores the previous Docker database automatically if the import or health check fails. Dumps are private files in the backup directory. Check the application and its logs, then remove `PROVIDERS_READ_ONLY` from `deploy/staging.yml` (or set it to `"0"`) and run `pnpm docker:update` to enable tracker writes. After a successful credential re-seal, remove `CREDENTIALS_KEY_OLD`.

From now on the Docker database is the only live copy. Development uses its own database: running the import again replaces newer production data, and continuing to log in dev does not synchronize it to Docker.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres connection string |
| `SESSION_SECRET` | `pnpm dev`: fixed; prod, `dev:build`, `preview`, `dev:https`: **required** | Keys module code tokens and module progress files; seals stored secrets and signs share links when `CREDENTIALS_KEY` is unset (sessions are random ids, not signed with it). To change it, see [key rotation](it/runbook-rotation.md) |
| `CREDENTIALS_KEY` (and `CREDENTIALS_KEY_OLD` to rotate) | from `SESSION_SECRET` | Seals stored secrets (tracker credentials and webhook secrets, mailbox sign-ins, mail copies, idea pictures; AES-256-GCM, bound to what they belong to) and signs share links; after a rotation the next start seals tracker credentials again, `cli.js reseal --apply` the rest ([key rotation](it/runbook-rotation.md)) |
| `PUBLIC_URL` | unset | The canonical external URL users reach the server at (e.g. `https://time.example.com`), used for sign-in redirects; never taken from the request's `Host` header. Must be an `https://` or `http://` URL without user, query or fragment, otherwise the server refuses to start |
| `PORT` | `3000` | Production port (Docker: `47823`) |
| `INKLEDGER_ADMIN_PASSWORD` | prod: random, in `INITIAL_ADMIN_PASSWORD_PATH` (`data/initial-admin-password`, mode 0600); dev: `admin` | The first admin's password on a new server (it must be changed at the first sign-in) |
| `SESSION_DAYS` | `30` | Lifetime of an unused session (sessions in use are renewed) |
| `REMOTE_ALLOWED_HOSTS` (or `JIRA_ALLOWED_HOSTS`) | any | Comma-separated self-hosted tracker hosts accepted; services on the internet are never limited by it |
| `GITHUB_CLIENT_ID` | the inkledger app | Your own GitHub OAuth App (device flow) for connecting GitHub, instead of inkledger's |
| `PROVIDERS_READ_ONLY` (or `JIRA_READ_ONLY`) | off | Refuse every write to a tracker |
| `SYNC_INTERVAL_MIN` | `5` | Minutes between background syncs (`0` disables) |
| `STORE_URL` | the inkledger store | Module store (Settings → Store); `off` disables it |
| `INSTANCE_KEY_PATH` | `data/instance.key` | This server's own key for module licences (made once; a copied database is not a copied server) |
| `WEATHER` | `on` | Real weather for modules that ask for it (Open-Meteo); `off` disables it |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,::1` | Host names the server answers to (LAN and Tailscale names are added from the app) |
| `TLS_DIR` | off (Docker stack: `/app/tls`) | Folder with `server.crt` and `server.key`; set, the server also answers over HTTPS |
| `HTTPS_PORT` | `3443` | HTTPS port, used only with `TLS_DIR` |
| `TRUST_PROXY` | off | Client IP from `X-Forwarded-For` behind a TLS proxy: `1` for one on this machine or the private network, or the proxies' addresses |
| `COOKIE_SECURE` | auto | Force `Secure` cookies behind a proxy without `X-Forwarded-Proto` |
| `BACKUP_DIR` | Docker: `/backups` | Where scheduled backups are written |
| `METRICS_TOKEN` | unset | Turns on `GET /api/metrics` (Prometheus), for requests with `Authorization: Bearer <token>`; unset, the route answers 404 |
| `READY_MIN_FREE_MB` | `1024` | Free space under `BACKUP_DIR` below which `/api/ready` fails |
| `ALERT_FAILURES` | `5` | Failed syncs in a row of one connection that raise an alert |
| `ALERT_COOLDOWN_MIN` | `360` | The same alert (one connection, the backup, one licence, the certificate) is not repeated within this many minutes |
| `RATE_LIMIT` | on | `off` turns the global request limits off (sign-in and shared-link limits stay) |
| `RATE_LIMIT_USER` / `RATE_LIMIT_IP` | `1200` / `6000` | API calls per signed-in account / per client address per window |
| `RATE_LIMIT_WINDOW_SEC` | `60` | The window of the global limits |
| `RATE_LIMIT_SSO` / `RATE_LIMIT_SCIM` / `RATE_LIMIT_EXPORT` | `30` / `600` / `10` | Single sign-on starts and callbacks per address, SCIM calls per token, exports per account, per window |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP/HTTP collector for request traces (e.g. `http://otel-collector:4318`); also `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` |
| `AUDIT_DIR` | `data/audit` (Docker: `/app/data/audit`) | The audit log's daily JSONL copy ([docs/it/audit.md](it/audit.md)) |
| `AUDIT_FILE_MIRROR` | on in production | Every audit event also written to that file (`0` turns it off; restores always write theirs) |
| `TZ` | system | Time zone for days and weeks (Docker inherits the host's) |

### Connecting GitHub

Settings → Connections → Add → GitHub: inkledger shows a short code, you enter it on github.com and authorize, and the connection is made. No password or token is pasted into inkledger and no callback URL is needed, so it works on a private address too. Connect as many GitHub accounts as you use (switch account on GitHub before each).

inkledger asks for `repo`, `read:project`, `project` and `notifications`. GitHub keeps no time: time logged on GitHub issues stays in inkledger. To use your own OAuth App instead (device flow enabled), set `GITHUB_CLIENT_ID`.

## Add-on modules

inkledger can load optional **add-on modules**: small, signed packages that add something on top of the app without touching your data. They come from **Settings → Store**: a module in free release has a **Request licence** button (your email and an optional message go to the developer; once approved, inkledger installs the module by itself), a paid one shows its price and the payment methods. Click a module's status badge to manage it (settings, export or import its progress, uninstall, remove the licence); a module whose licence you hold reinstalls or updates from there with one click. Each module has its own on/off switch, and another switch turns them all off on a device. A module starts from zero when installed; its progress can be exported to a file and brought back. A module runs inside your own inkledger: no account, no tracking. A licence is activated on up to three of your servers (Settings → Store shows them), renewed every 90 days with 30 days of grace when the store can't be reached; a server that never reaches the internet is activated with an offline code.

Licences follow the [module terms](modules-terms.md). The store and, when a module asks for real weather, [Open-Meteo](https://open-meteo.com) are the only outbound calls besides your trackers (weather requests carry only coordinates rounded to 0.1°, are cached 30 minutes and stop with `WEATHER=off`): this server asks the store for the catalog when someone opens Settings → Store (at most every 12 hours; the last copy is kept), and for the licence while a request or a payment is pending. `STORE_URL=off` turns it off.

| Module | What it is | |
|---|---|---|
| **Kanbunny** | A felt desk bunny that lives on the bottom edge of your work. It eats a carrot for every ticket you close, hops when cards move, levels up with the hours you log and collects trophies and outfits. It always finds a spot that does not cover what you read. | [Overview, video and PDF](kanbunny/README.md) |
| **Desk Radio** | A little felt cassette at the bottom of the sidebar: lo-fi stations and tapes, rain, café, fireplace or forest sounds made live in your browser. It answers closed tickets with a chord, plays a warm sweep at your daily goal and keeps playing in the folded rail or on a phone. | [Overview, video and PDF](deskradio/README.md) |
| **Stitch** | An embroidery hoop on your dashboard: the hours you log this week stitch a cross-stitch pattern, finished exactly at your weekly goal. Closed tickets add gold, every week joins a collection and any week saves as a picture. | [Overview, video and PDF](stitch/README.md) |
| **City Window** | A train window behind your Dashboard: painted worlds roll past under the real sky and weather where you are, every closed ticket lights a window and your daily goal brings a station with fireworks. In beta. | [Overview and pictures](citywindow/README.md) |
| **Bonsai** | A maple bonsai on your dashboard, path traced like a photograph: the hours you log make it grow, closed tickets bring buds and flowers, your daily goal makes it bloom, through the real seasons. In beta. | [Overview and pictures](bonsai/README.md) |
| **Shadow** | Real shadows across the whole app: buttons, cards, menus and the panel cast a shadow away from the sun or the moon where you are, long at dawn and sunset, short at noon, faint by moonlight, none on a dark night. Nothing animates. | [Overview and pictures](shadow/README.md) |

These modules are in free release: request a licence from the store.

<p align="center">
  <a href="kanbunny/README.md"><img src="kanbunny/kanbunny-poster.webp" alt="Kanbunny, a felt desk bunny next to its burrow" width="560"></a>
</p>

## Native apps and devices

The native app is a thin Tauri shell around your server: menu bar and tray timer, global shortcuts (⌥⇧T start, ⌥⇧P pause, ⌥⇧J show), system idle detection, notifications and launch at login. It keeps several **server profiles**, each with its own tracker connections and user.

From **Settings → Devices** you can add a phone or another computer. Use Tailscale (HTTPS on your tailnet, published on the same port the server uses locally) or the local Wi-Fi: the app creates a local certificate authority, and the phone installs it once from a QR code. Android downloads the APK from `/install`; on iPhone, inkledger installs as a web app. Details are in [native.md](native.md).

## Monitoring and alerts

- **`GET /api/health`** is liveness: the database answers. The Docker health check and `pnpm docker:update` use it.
- **`GET /api/ready`** says whether the server can do its work: the database, migrations applied, free space under `BACKUP_DIR`, the age of the last good backup against its schedule (one missed run is tolerated), the background sync alive. JSON with one entry per check (`ok`, `failed`, or `skipped` when the feature is off); `503` when any check failed. It carries booleans and ages only.
- **`GET /api/metrics`** (Prometheus text) is off until `METRICS_TOKEN` is set. Requests by route template and status, latency histogram, database pool, sync passes and failures by provider type, connections by status, outbox depth, last good backup, refused sign-ins, rate-limit refusals, open live-event streams, plus the process's memory, uptime and event-loop delay. Labels never carry a path, a URL or a user. The scraper's `Host` must be in `ALLOWED_HOSTS` (a request addressed to another name gets 421).
- Examples for Prometheus (scrape and alert rules) and a Grafana dashboard are in [`deploy/monitoring/`](../deploy/monitoring/).
- **Tracing** is optional: with `OTEL_EXPORTER_OTLP_ENDPOINT`, one span per request (method, route template, status) goes to that collector over OTLP/HTTP. The address is checked like a tracker's (never this server's neighbours or metadata addresses), so a collector on `localhost` is refused: run it as its own service.

**Alerts.** A connection that stops working (credentials refused or unreadable, out of reach, or `ALERT_FAILURES` failed syncs in a row), a failed backup, a licence that could not be renewed, and an HTTPS certificate within 30 days of its end raise an alert where it happens, with no polling of their own (the certificate is looked at after sync passes, at most daily). Each subject is told once per `ALERT_COOLDOWN_MIN`:

1. in the app: the connection's owner, or for the server's own alerts every account with *Server settings*;
2. in Settings → Network, the alerts firing now;
3. optionally, a webhook set in Settings → Network (Slack or Mattermost `text`, a Microsoft Teams workflow's Adaptive Card, or plain JSON). Every post carries `X-Inkledger-Timestamp` and `X-Inkledger-Signature: sha256=<HMAC-SHA256 of "<timestamp>.<body>">` with the secret shown once when the URL is saved. The URL is checked when saved and again before each post (no loopback, link-local or metadata addresses, no redirect to another site) and stored sealed like tracker credentials. A read-only server (`PROVIDERS_READ_ONLY`) sends none.

**Rate limits.** Every API call counts against generous per-account and per-address limits (`RATE_LIMIT_*`), beside the stricter sign-in and shared-link limits; a refused call gets `429` with `Retry-After` and is counted in `inkledger_rate_limited_total`. Behind a proxy, set `TRUST_PROXY`, or every client shares the proxy's address. The limits are counted in memory, per process: run **a single replica** per database.

## Security and privacy

- Self-hosted, **no telemetry**. Outbound calls go to the trackers you connect, to the module
  store (only when Settings → Store is opened or a licence is pending; `STORE_URL=off` stops it)
  and to Open-Meteo for modules that ask for weather (coordinates rounded to 0.1°; `WEATHER=off`).
- In production, without `REMOTE_ALLOWED_HOSTS`, only an admin may connect a self-hosted tracker.
- Tracker secrets are sealed with AES-256-GCM, bound to their connection, and only used server-to-tracker.
- Trackers not verified on a real account only read until you allow writes; `PROVIDERS_READ_ONLY=1` refuses every write.
- `HttpOnly` / `SameSite=Lax` cookies (`Secure` over HTTPS), session ids stored as hashes, `Origin` check on writes, rate-limited sign-in.
- Remembered devices hold only a rotating token. The remembered token is rotated on every use.
- Tracker URL guard (no loopback or link-local), host allowlists, security headers, body limits, global per-account and per-address rate limits.

## Architecture

```
api/          Hono + tRPC server: routers, tracker and time-tracker providers (../api/providers/<type>, each with an HTTP simulator), outbox, sync, webhooks, backups
contracts/    Code shared by app and server: durations and local dates, placement, schedules, i18n
db/           Drizzle schema → drizzle/ migrations (applied at start; a test catches drift)
src/          React 19 app: pages, feature components, design primitives (src/components/app)
src-tauri/    Native shell (Rust): profiles, tray, shortcuts, idle, LAN HTTPS, Tailscale
api/modules/, src/modules/   Add-on module loader: signed packages, licences, slots, host API
e2e/          Browser regressions, one per interaction that ever broke
```

**Stack:** React 19, Vite 7, Tailwind CSS, Radix UI, TanStack Query, tRPC 11, Hono, Drizzle ORM, Postgres 17, Tauri 2, Node 24.

## Development

```bash
pnpm install
docker compose up -d db          # Postgres on 127.0.0.1:54329 (also the container's)
docker exec inkledger-db createdb -U inkledger inkledger_dev   # the dev server's own database
cp .env.example .env             # set DATABASE_URL and SESSION_SECRET
pnpm dev                         # http://localhost:3000
```

The production server marks its database as its own: a development or test process refuses to apply migrations to it (`ALLOW_MIGRATE_PRODUCTION_DB=1` overrides), and any server refuses to start on a database migrated by a newer inkledger.

Use `PROVIDERS_READ_ONLY=1` when you point a development server at a real tracker.

For Lighthouse against the real development data, use `pnpm preview` at `http://127.0.0.1:4173`. It builds the optimized frontend, then serves its assets and SSR from the development backend: login, APIs and the `.env` database keep working. This does not set `NODE_ENV=production` or mark the development database as production-owned. `PORT=4173 pnpm dev:build` is the explicit equivalent; `pnpm dev` stays alone on port 3000 with HMR. Rerun the preview after frontend changes to rebuild them, and do not point another dev-build at port 3000 while Vite is running.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server with HMR (port 3000) |
| `pnpm dev:https` / `pnpm https` | Fresh build for other people on the network: :4173, with HTTPS on :3444 in front (:3443 is the container's); local CA and proxy (see [https.md](https.md)) |
| `pnpm dev:build` / `pnpm preview` | Optimized build and SSR served by the development backend, with working login, APIs and `.env` database |
| `pnpm build` / `pnpm start` | Production build (`dist/`) and server |
| `pnpm lint` | ESLint and the design-token check |
| `pnpm check` | TypeScript (strict) |
| `pnpm test` | Unit and integration tests (Vitest, Postgres via PGlite) |
| `pnpm test:smoke` | Boots the production bundle: health, headers, SPA fallback |
| `pnpm test:e2e` | Browser regressions (Playwright) against a throwaway database |
| `pnpm db:generate` | Migration from `db/schema.ts` into `drizzle/` |
| `pnpm tauri:dev` / `tauri:build` | Native shell (see [native.md](native.md)) |
| `pnpm native:publish` | Builds the Android app and serves it from `/install` |
