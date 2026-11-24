# Runbook: security incident

Steps for a compromised or misused account, or a leaked secret. Each action is recorded in the [audit log](audit.md); take note of the time you start.

## 1. Contain an account

1. Settings → Users → the account → **Turn off**. The account cannot sign in and its sessions and remembered devices end at once (an admin can disable accounts; managers cannot disable admins).
2. To keep the account but end its access: **Reset password**. The old password stops working, the account is signed out everywhere and must choose a new one.
3. If every admin is locked out: `docker exec <app-container> node dist/cli.js reset-password <username>`.
4. Tracker side: revoke the user's tokens in the tracker itself, and reconnect with new credentials. Nothing in inkledger can revoke a token the tracker issued.

## 2. Sign everyone out

- Restoring a backup ends all sessions ([runbook-restore.md](runbook-restore.md)).
- Otherwise reset the passwords of the affected accounts, or disable and re-enable them. Changing `SESSION_SECRET` does not end sign-in sessions (they are random identifiers kept as hashes).

## 3. Rotate keys

If the host, the environment file or a backup was exposed, follow [runbook-rotation.md](runbook-rotation.md): back up, set a new `CREDENTIALS_KEY` with the old one as `CREDENTIALS_KEY_OLD`, run `reseal --apply`, then change `SESSION_SECRET`. Also rotate the tracker credentials stored in the server, the alert webhook secret and `METRICS_TOKEN` if they could have been read, and the database password.

## 4. Export the audit log

1. Settings → Audit log (needs `viewAudit`): filter by actor, action and time; check the chain shows intact.
2. Export CSV or JSON (needs `exportAudit`), or `GET /api/audit/export?format=json&...` with the same filters.
3. Copy the daily files in `AUDIT_DIR` (`audit-YYYY-MM-DD.jsonl`) to storage the server cannot change: they survive a restore and show edits to the database copy.
4. Pay attention to failed sign-ins, access changes, new connections, backup runs and restores, and reads of other people's time.

## 5. After

- Preserve a backup taken now before changing more.
- Confirm Settings → Network shows no unexpected host.
- Review who holds `manageUsers`, `manageServer`, `manageBackups`, `viewTeamTime` and the audit permissions.
- Report a product vulnerability privately as in [../../SECURITY.md](../../SECURITY.md).
- If personal data was exposed, see [gdpr.md](gdpr.md) for the operator's notification duties.
