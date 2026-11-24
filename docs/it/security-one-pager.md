# Security at a glance

One page for a security review. Details are in the linked documents.

## Architecture

- One self-hosted server (Hono and tRPC on Node) and one Postgres database, run by you, usually with the Docker stack. Single replica per database: rate limits and live streams are kept in memory.
- Clients are a web app (also installable as a PWA) and a native shell around the same server. Nothing is stored by a vendor: no cloud component, no telemetry.
- The image runs as a non-root user, with a health check. Data flow: [data-flow.md](data-flow.md). Outbound connections: [outbound.md](outbound.md) (live list in Settings → Network).

## Authentication and sessions

- Local accounts: username and password (scrypt hashes, minimum length 12), invite links (7 days, one use), forced password change, rate-limited sign-in (per account and per address). Single sign-on is not part of the product today.
- The first admin gets a random password in production, and a command-line reset exists for lockouts (`node dist/cli.js reset-password <username>`).
- Sessions are random identifiers stored as hashes. They last `SESSION_DAYS` (30 by default) and renew while in use. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS. A remembered device holds a rotating, single-use token.
- Resetting a password, changing it, or disabling an account signs that account out everywhere.
- Writes from other sites are refused (`Sec-Fetch-Site` and `Origin` checks). The server answers only to the names in `ALLOWED_HOSTS`. Set `TRUST_PROXY` behind a proxy.

## Encryption

- In transit: HTTPS to the server ([../https.md](../https.md)).
- At rest: tracker credentials, webhook secrets, mailbox sign-ins, mail copies and idea pictures are sealed with AES-256-GCM, each bound to its record, with `CREDENTIALS_KEY` (rotation: [runbook-rotation.md](runbook-rotation.md)). Passwords are hashed, session and invite tokens are stored as hashes. The rest of the database is not encrypted by the application: use disk or volume encryption on the host if you need it. Backup files in `BACKUP_DIR` are not encrypted by the application either, but are written readable by the server's user only; off-site copies are encrypted before they leave.

## Permissions

Accounts are `admin` or `member`. Members hold none of these unless granted: `manageUsers`, `manageStore`, `manageBackups`, `manageServer`, `viewTeamTime`, `useModules`, `viewAudit`, `exportAudit`. Admins hold all. A manager cannot grant more than they hold, cannot edit another manager, and the last admin cannot be removed or disabled. Restoring a backup is for admins only. Every user sees their own data only, except through `viewTeamTime`, which reads everyone's logged time on the server.

## Audit log

Sign-ins, access changes, settings, connections, backups and restores, reads of others' time and worklog writes are recorded: append-only in the database, hash-chained, mirrored to daily files, retained 400 days by default. Readable and exportable by accounts granted it. See [audit.md](audit.md).

## Backups

Scheduled `pg_dump` files in `BACKUP_DIR`, a safety backup before every restore, restore refused for a backup from a newer version, sessions ended by a restore. Nothing is uploaded unless an admin turns on off-site copies: to S3, encrypted on the server with `BACKUP_KEY` (AES-256-GCM, a key kept outside the database), or to a restic repository (encrypted by restic). A weekly restore drill restores the newest backup into a scratch database, checks it and alerts when it fails. See [runbook-restore.md](runbook-restore.md) and [runbook-upgrade.md](runbook-upgrade.md).

## Other safeguards

- Tracker URL guard (no loopback, link-local or metadata addresses), `REMOTE_ALLOWED_HOSTS` allowlist, redirects to other origins refused.
- Trackers not verified on a real account only read until writes are allowed; `PROVIDERS_READ_ONLY=1` refuses every write.
- Security headers, body limits, per-account and per-address rate limits, request logs without tokens.
- No telemetry. Optional traces and alert webhooks go only to hosts you set.

## Vulnerability reporting

Privately, through GitHub's private vulnerability reporting on the repository (Security tab). Answer within a week; only the latest release is supported. Details: [../../SECURITY.md](../../SECURITY.md).

## Dependencies

Dependabot watches npm, Cargo, the Docker base image and CI actions weekly; minor and patch updates arrive grouped, security fixes as they come. Every major update is adopted by migrating the code, not skipped or ignored. CI actions are pinned by commit and the image base by digest.
