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

## Without the app

If the server cannot start, restore with `pg_restore` into an empty database of the same Postgres major version, using the same environment file and keys, then start the server (it applies any migrations it needs).

## Verify afterwards

1. `GET /api/health` answers, and `GET /api/ready` reports the database, migrations and sync as `ok`.
2. Sign in; Settings → Audit log shows the chain intact and a `restore.completed` event.
3. Settings → Network and the connections list: no connection shows "unreadable" (that means the wrong `CREDENTIALS_KEY`). Run `docker exec <app-container> node dist/cli.js keys-status` to count unreadable values.
4. Open this week's time and compare with a tracker; run a sync.
5. Check the next scheduled backup completes. Keep the safety backup until you are sure, then it is pruned like any other.
