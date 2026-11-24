# Audit log

Who did what on the server, when and from where. Admins and accounts granted **Audit log** (`viewAudit`) read it in **Settings → Audit log**; `exportAudit` also downloads it as CSV or JSON.

## What is recorded

- Sign-ins, failed ones included (password, remembered device, invite, activation), and sign-outs. A failed sign-in for a name no account has keeps no name: it may be a password typed in the wrong field.
- Accounts: invites, access changes (before and after), renames, password resets, turning an account off or on.
- Settings of each account, server settings (device access, backup schedule, retention), connections (added, reconnected, writes allowed, webhooks, options, archived), the Store, licences and modules, backups and restores.
- Reads of other people's time (the team report), once per reader and range every ten minutes.
- Worklogs written by their user (create, edit, delete, restore). Sync writes one event per pass that changed something (actor `sync`), never one per worklog.
- Every mutation behind a permission writes exactly one event: done, failed, or refused for lack of the permission. A module's own storage and files are the exception (written as the module runs).

Each event keeps the actor, the action, the target, the outcome, the client address, a short hash of the User-Agent, and what changed. What changed is redacted per action: only the fields listed for that action in `contracts/audit.ts` are kept; any other field shows as `[redacted]`. Passwords, password hashes, tokens, licence texts and secrets are never stored.

## Integrity

- **Append-only.** A database trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` on `audit_events`. Only the retention purge deletes, inside its own transaction with `inkledger.audit_purge` set.
- **Hash chain.** Each row's hash covers the row before it. Settings → Audit log shows whether the chain is intact; an edited or removed row is named.
- **Tamper-evident, not tamper-proof.** The app's database role owns the table, so whoever holds that role (or the host) can switch the trigger off and rewrite rows: the chain shows it, it does not prevent it. Operators who need more can give the table to a separate owner role and grant the app's role only `INSERT` and `SELECT` on it (and `DELETE` for the purge), and keep the file copy on storage the app can only append to.

## File copy

With `AUDIT_FILE_MIRROR=1` (the default in production) every event is also appended to `audit-YYYY-MM-DD.jsonl` in `AUDIT_DIR` (default `data/audit`, `/app/data/audit` in Docker, inside the data volume), one file per day. Restores always write there, mirror on or off: a record before the database is replaced (with the hash of the last event) and one after. A restore rewinds the database, and the log in it, to the backup's; the first event after it, `restore.completed`, carries the hash of the last event before the restore, so the two histories can be joined. Rotate or ship the files with your usual log tooling.

## Retention

`audit.retentionDays` (Settings → Audit log; whoever manages the server sets it): 400 days by default, never under 90. The server's purge (every 6 hours) removes older events and records how many it removed and the last removed hash; the chain is then checked from the oldest event left.
