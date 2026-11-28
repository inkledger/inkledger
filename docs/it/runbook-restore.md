# Runbook: restoring a backup

Restoring replaces the whole database with the contents of a backup file: accounts, connections, time, settings and the audit log all go back to that moment. Work done since is lost. Only an admin can do it.

## Before

1. Say who is affected: everyone is signed out, and the server refuses writes while it runs.
2. Check the file: Settings → Backup lists the files in `BACKUP_DIR` with their dates. Pick the newest one from before the problem.
3. Have the keys that were in use when the backup was taken. A backup holds sealed values: `CREDENTIALS_KEY` (and `CREDENTIALS_KEY_OLD` if used) must open them ([runbook-rotation.md](runbook-rotation.md)).
4. The backup must come from this version or an older one. One from a newer version is refused (see below).

## Restore in the app

1. Settings → Backup → the file → **Restore**, and confirm.
2. The server finishes syncs under way, then **takes a safety backup of the current data first** (a new file in the same list; its name is shown when the restore ends).
3. The database is emptied and the backup loaded in a single transaction: if anything fails, nothing changes. If it fails after the data was replaced, the safety backup is put back automatically; the error names it.
4. The sessions and remembered devices in the backup are removed in the same transaction, so everyone signs in again. The admin who restored stays signed in when their account exists in the backup.
5. The audit log is the backup's. The file copy in `AUDIT_DIR` records the restore before and after, and the first event afterwards, `restore.completed`, carries the hash of the last event before it ([audit.md](audit.md)).

### A newer backup is refused

If the file holds migrations this version does not know, the restore stops with "This backup comes from a newer inkledger" and nothing is changed. Restore it on a server running that version or newer, or use a backup taken with this one. After a failed upgrade, use [runbook-upgrade.md](runbook-upgrade.md) instead: it restores the dump taken before the update.

## Restore from an off-site copy

> **A read-only server copies nothing off-site.** With `PROVIDERS_READ_ONLY=1` (or `JIRA_READ_ONLY=1`), for example a staging or test server on a copied database, every off-site copy is skipped, the scheduled ones and **Copy now** alike; local backups go on as usual. Settings → Backup → Off-site copies says so ("Skipped: this server is read-only"), and the server log has `[backup] off-site copy skipped: read-only server`. Such a server's newest off-site copy is as old as the last one taken before it went read-only.

When the backups folder is gone (a lost disk or host) but off-site copies are on (Settings → Backup → Off-site copy):

1. Start a server of the same version or newer, with the same environment file: `CREDENTIALS_KEY` (and `_OLD`) as when the copy was taken, and `BACKUP_KEY` (S3; add `BACKUP_KEY_OLD` if the copy predates a key change) or `RESTIC_REPOSITORY`/`RESTIC_PASSWORD` (restic).
2. Sign in as an owner (on a new server, the first admin) and set Settings → Backup → Off-site copy back to the same bucket and folder (or kind restic).
3. Off-site copies → **Show the copies** → the copy → **Restore**, and confirm. Only an owner holding "restore backups" sees the button.
4. The server downloads the copy into `BACKUP_DIR`, decrypts it and checks every byte before the file appears (a copy altered or cut short is refused, nothing changes), then restores it exactly as above: safety backup first, one transaction, sessions ended, `restore.completed` in the audit log.
5. The data folder archive comes back beside it as `inkledger-<date>-<time>.data.tar.gz` (mode 0600). It holds the installed modules, downloads and the audit file copy, and `instance.key` once the server has one: the key is made the first time the server needs its identity (a module licence activated or checked, feedback forwarded upstream), so a server that never did has none, and its archive holds none. It is in the archive only where `INSTANCE_KEY_PATH` lies in the data folder (the default, `/app/data/instance.key`). On a new host, stop the app, extract it into `/app/data` (`tar -xzf <file> -C /app/data`, as the container's user), start the app, then delete the archive. When the archive held `instance.key`, restoring it keeps module licences activated for this server; without one, the server makes a new key when it first needs it.

### Without the app (off-site)

- **S3:** download `<prefix>inkledger-<date>-<time>.dump.enc` and `.data.tar.gz.enc` with any S3 client, then decrypt each with `BACKUP_KEY` set: `docker run --rm -e BACKUP_KEY -v "$PWD:/w" <image> node dist/cli.js decrypt-backup /w/<file>.enc /w/<file>`. The command writes the output only once every byte has verified. Restore the dump with `pg_restore` as below.
- **restic:** `restic snapshots --host inkledger --tag inkledger`, then `restic dump <id> <path>/inkledger-<date>-<time>.dump > inkledger.dump` (the path is the one the snapshot lists).

## Restore drill

Settings → Backup → Restore drill restores the newest backup into a scratch database, `inkledger_drill`, on the same Postgres server. It never touches the live database, and refuses to run when the live database itself is named `inkledger_drill`. It then checks the copy: counts of accounts, worklogs and connections, the newest migration (no newer than this build), and that every sealed value opens with the keys configured now. Then it drops the scratch database. It runs once a week on the server (switch "Every week") and on **Run drill**.

- The database role of `DATABASE_URL` needs `CREATEDB` (the default `POSTGRES_USER` of the compose stack has it). Without it the drill fails with "permission denied to create database".
- A failed drill raises an alert (in-app, Settings → Network, the webhook) and is written to the audit log as `backup.drill`, with the result. A drill cut short leaves `inkledger_drill`: the next drill drops it first.
- "sealed value(s) don't open": the keys in the environment would not open that backup's secrets after a restore. Fix the keys before you need the backup ([runbook-rotation.md](runbook-rotation.md)).
- Before an upgrade, check that the last off-site copy and the last drill are both recent and passed ([runbook-upgrade.md](runbook-upgrade.md)).

## Without the app

If the server cannot start, restore with `pg_restore` into an empty database of the same Postgres major version, using the same environment file and keys, then start the server (it applies any migrations it needs).

## Verify afterwards

1. `GET /api/health` answers, and `GET /api/ready` reports the database, migrations and sync as `ok`.
2. Sign in; Settings → Audit log shows the chain intact and a `restore.completed` event.
3. Settings → Network and the connections list: no connection shows "unreadable" (that means the wrong `CREDENTIALS_KEY`). Run `docker exec <app-container> node dist/cli.js keys-status` to count unreadable values.
4. Open this week's time and compare with a tracker; run a sync.
5. Check the next scheduled backup completes. Keep the safety backup until you are sure, then it is pruned like any other.
