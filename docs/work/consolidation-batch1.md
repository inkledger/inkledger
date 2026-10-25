# Status: consolidation, Batch 1 (perimeter and accounts)

Plan: the audit's P1 list (items 3, 4, 6, 7, 8, 10) plus the related P2 items. Batch 0 (P0 time
loss) and Batch 2 belong to another session: see `consolidation-batch0.md`.

## Goal and done criteria
Every item below has a regression test that failed for the expected cause before its fix. The
targeted tests, `tsc -b` and eslint on the touched files pass.

## Constraints and out of scope
- Worked in the worktree `.claude/worktrees/batch1` (branch `consolidation-batch1`, from `b453333`),
  not in the shared checkout, where Batch 0 was being edited at the same time.
- No commit. The worktree's changes reach the shared checkout as one patch.

## Decisions
- **First admin in production:** with no `INKLEDGER_ADMIN_PASSWORD`, a random password is written
  to `INITIAL_ADMIN_PASSWORD_PATH` (default `data/initial-admin-password`, mode 0600) and only its
  path goes to the log. The file goes once the password is changed. Development keeps `admin`, and
  the e2e harness passes `admin` explicitly.
- **Password change:** the session it was changed in ends too, and the device gets a new one (the
  old cookie, or a copy of it, stops working). The existing test asserted the opposite; it is
  updated on purpose.
- **Activation:** a site is contacted only if an account on this server has a Jira connection to
  it. A site with no such connection now answers `NOT_FOUND` before any request, where it used
  to report Jira's failures. The existing test is updated on purpose.
- **Request log:** paths only. The query (tRPC inputs: an invite's token) is dropped, and a
  webhook's token is shown as `…` (`api/lib/requestLog.ts`, replacing `hono/logger`).
- **Store pictures:** a picture on the origin of `STORE_URL` is fetched as is, with no redirect
  followed: the operator chose it, and a self-hosted store or the e2e stub may be on the LAN. Any
  other picture must be https on a public host, fetched through `safeFetch` (redirects followed by
  hand and checked again). The size cap is enforced while the body streams. A refused host throws,
  as a network failure did: the route answers 404 and nothing is cached.

## Batches and progress
- [x] Rate limiter: the address is checked before the account (a blocked address no longer locks
      an account out), and the limiter holds a bounded number of keys (`maxKeys`, expired keys
      dropped first).
- [x] Session rotation on password change.
- [x] Activation contacts no site without an account connected to it.
- [x] The first admin in production gets no public default password.
- [x] Request log without queries or webhook tokens.
- [x] Backup dumps are 0600: `api/backup.ts`, `scripts/docker-update.mjs`, `scripts/docker-from-dev.mjs`
      (backup folder 0700 when the script creates it).
- [x] Purge of expired remembered devices and invite links (`purgeExpiredAccess`, in the 6-hourly purge).
- [x] Store pictures: https only, public hosts only, redirects checked, streaming size cap.
- [ ] `MODULES_TRUST_EXTRA_KEY` refused in production. Blocked on a decision: e2e (`e2e/store`,
      `e2e/modules`) and studio (inkledger-modules `scripts/studio`) run the production bundle with
      it, so they need an explicit opt-in.
- [ ] Self-hosted allowlist mandatory in production, or a dedicated permission
      (`api/routers/connections.ts`).
- [ ] Store client (`api/store/client.ts`): `redirect: "manual"` on calls to `STORE_URL`.
- [ ] Native: Tailscale Serve only for the active profile's port, and narrower capabilities (`src-tauri`).

## Checks
| Command | Scope | Result |
|---|---|---|
| new tests before the fixes | auth, security, requestLog, accounts-queries, backup, store | failed for the expected cause |
| `vitest run api/store api/routers/auth.test.ts api/lib api/queries/accounts-queries.test.ts api/backup.test.ts api/backupSchedule.test.ts` | worktree | 223/223 |
| `tsc -b` | worktree | pass |
| `eslint` on the touched files | worktree | pass |
| full `pnpm test`, build, smoke, e2e | after the merge into the shared checkout | to run |

## Blocks and next step
1. Merge into the shared checkout. This session can write only to its worktree, so the user
   applies the patch.
2. Run the full gate.
3. Continue with the open items above.
