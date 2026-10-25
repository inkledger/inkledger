# Status: consolidation (Batches 0, 2, 3, 4 and the P1s left from Batch 1)

Plan: the audit's P0 1–2 and Batch 0. Batch 1 (auth/security) is run by another session on
disjoint files (docs/work/consolidation-batch1.md).

## Done criteria
- A tracker that landed a write while its answer was lost, timed out, odd, or followed by a
  fault on this side: one row here and one entry there after the replay, never a deletion.
- A certain refusal: nothing kept. Never a double entry.

## Decisions
- `normalizeError`: a signal aborted by a deadline (reason `TimeoutError`) is `timeout`
  (transient), not `cancelled`.
- `certainRefusal` (api/providers/trpc.ts, built on `isRefusal`) is the only reason to drop a
  write: no answer, a cancel, `incompatible`, a fault of ours, a 5xx leave it open.
- Trackers: `createThrough` splits the remote call from recording it (`createThere` +
  `landed`). An uncertain create is queued, and its replay adopts what landed (adoptLanded).
  A local fault after the tracker said yes keeps the row and queues it. `updateThrough`
  queues uncertain edits; this side's changes go in one transaction. `deleteThrough` queues
  anything but a refusal.
- Replay of an edit that landed with its answer lost (`conflict`, the entry already holds
  these values): its revision is recorded, nothing is sent again (`alreadyUpdated`).
- Sinks without an idempotency key (Tempo): the first send's time is kept on the link
  (`worklog_sinks.synced_at` while unsynced). Before sending a create again, the day is read
  and an entry of ours made after that time is adopted (`landedBefore`). Before this, an odd
  answer from Tempo logged the time twice.
- Companion create/update/delete follow `certainRefusal` as trackers do.

## Checks
| Command | Scope | Result |
|---|---|---|
| new tests before the fix | timeWrites ×4, companion ×1 | failed for the expected cause (Cancelled → deleted; incompatible → deleted; `disk full` → deleted; update thrown; Tempo 2 entries) |
| `vitest api/sync/timeWrites api/providers/trpc api/sync/companion api/sync/extraSinks api/sync/sinkDayTotals` | Batch 0 | pass |
| `pnpm test` | all unit | 2175/2175 |
| `pnpm lint`, `pnpm check` | repo | pass |

## Batch 2 (queues and invariants across processes)
- [x] Claim-aware edits: `updateThrough`/`deleteThrough` claim the worklog's queued edits
  before the tracker call (released on a refusal, dropped on success); one a replay is
  sending: CONFLICT (`server.worklogs.justSynced`). `outbox.discard` deletes only an
  unclaimed entry, CONFLICT otherwise.
- [x] Sink lease: `worklog_sinks.claimed_at` (migration `0010_write_claims`); `pushSinks`
  claims due entries at once, skips claimed ones, releases at the end of the pass.
- [x] Shared write lease: `write_leases` (same migration), `api/queries/writeLease.ts`. It
  replaces the in-process lock for worklog create/update/restore/delete. `weeks.close`/
  `reopen` and `timers.start(from)` take it too. Week checks run again under it. Lease row,
  not a held DB lock: the tracker call happens under it without holding a connection;
  2 min expiry for a dead holder; 45 s wait, then TIMEOUT (`server.worklogs.busy`).
- [ ] Restore maintenance mode: waits for the Batch 1 patch to api/backup.ts (another
  session) to be applied.

| Command | Scope | Result |
|---|---|---|
| new unit tests before the fix | claimed edit/delete/discard; sink lease; write lease ×2 | failed for the expected cause |
| `e2e/multi-process.test.mjs` | two server processes, real Postgres, 6 rounds of overlapping creates | pass; with the old in-process lock: `200,200` (double time) |
| `pnpm parity:update` | i18n `server.worklogs.busy` added | only that key changed |
| `pnpm lint && pnpm check && pnpm test` | repo | pass, 2180/2180 |

## Batch 3 (no UI write on uncertain data) and release fixes
- [x] Day Review: Log disabled until today's worklogs and timers are read (`logAll` checks too);
  a failed read shows an ErrorState with Retry (`useBlockPlacement` → `error`, `retry`).
  Timers stopped on an earlier day are not preselected, and `usePendingSeconds` counts today's
  only (`src/lib/timerDay.ts`).
- [x] ManageIssue: assignees or description that failed to load show ErrorState + Retry, no
  form. A current assignee missing from the tracker's options is kept and checked.
- [x] `scripts/dist.mjs` (P1 #17): stale bundles removed before building; build failure
  before the .app fails; old APK refused; per-file commit/dirty; `--allow-dirty` required on
  a dirty tree.
- [x] LogTimeDialog/QuickLog: a failed read of the day says so, with Retry (no endless "computing").
- [x] CommandPalette: one key and title on two trackers are two options (value carries issueId).
- [x] TransitionDialog: a fresh form per ask (issue, tracker, transition, or asked again).
- [x] Issues: a failed refresh of the same list says it may be out of date, with Retry.
- [x] Trash: loading and error states with Retry.
- [x] Keyboard list: rows carry `data-issue-id` (desktop and mobile), found by the selection.
- [x] Dialog/AlertDialog: bounded to the viewport, scrolling (last action reachable).
- [x] RichText collapsed: cut-off links and buttons out of the tab order until "Show all".
- [x] TimerNote: one save in flight, always the newest text; a failed save is said, kept in
  the field and on the device (localStorage, try/catch), sent again with the next change.
- [x] GapCutter: comments, "All on one" and the C shortcut locked while saving.
- [x] ModulesProvider: modules not allowed or switched off stop at once; the shared hub is
  disposed after the last one.
- [ ] axe checks on key routes: needs the `axe-core` dev dependency (package.json, coordinated
  with the Batch 1 session); not added yet.

| Command | Scope | Result |
|---|---|---|
| `e2e/day-review.test.mjs` | 3 scenarios (2 new) | pass; "logged on guesses" failed before the fix (no alert) |
| `e2e/manage-issue.test.mjs` | 3 new scenarios | pass; all 3 failed before the fix |
| `e2e/placement-errors`, `same-key` (palette), `transitions` (reset), `stale-errors` ×3, `keyboard-list`, `richtext-collapse` | new scenarios | pass; each failed before its fix (keyboard proved by reverting) |
| `pnpm parity:update` | i18n keys added (5) | only those keys changed |
| `e2e/timer-note` ×2, `regressions` (gap lock), `modules` (revoked) | new scenarios | pass; each failed before its fix |
| `node scripts/dist.mjs` on a dirty tree | guard | refused |
| `node scripts/dist.mjs --mac --allow-dirty` | mac release | built; manifest flags the APK from an earlier build |

## Batch 4 (sync complete and observable)
- [x] `outbox.retry`: a sink's queued deletes go through `pushSinks` (forced), not
  `replayContract` (a sink has no tracker to replay against).
- [x] Manual Sync: `SyncResult.failed` lists the trackers that failed (in the user's words),
  and a warning toast shows them. When every tracker it tried failed, the Sync fails
  (SERVICE_UNAVAILABLE). Background passes are unchanged. The tRPC output got the new
  field: compatible; parity updated deliberately.
- [x] Stream lease: heartbeat (`HEARTBEAT_MS` = lease/4) while a pass runs; `succeeded`
  checks it still holds the lease, otherwise `LeaseLostError` and nothing recorded.
- [x] Jira first import: every search page (no 5000 cap), each issue once.
- [x] Stand-in: Tempo can't stop or change standing in while it has that tracker's time to send.
- [ ] Module activation grace (activation.ts): not done yet.

## P1s left by the Batch 1 session (its own patch covers #3, #4, #6 activation and store images, #7, #8, #10)
- [x] #16 `scripts/docker-update.mjs`: when the new image migrated the database, the rollback
  restores this run's dump before starting the previous image. Without a dump it stops and
  prints the recovery steps, never claiming a rollback. `--rehearse-rollback` exercises it.
- [x] #6 rest: self-hosted trackers (token or Jira Server/DC) in production with no
  `REMOTE_ALLOWED_HOSTS` are an admin's to add (`.env.example` says so). Store client: no
  redirects, answers capped at 1 MB.
- [x] #5 rest: `tailscale_serve` publishes only the local server the window shows, on its own
  port, and only if inkledger answers there (Rust test). The remote capability stays
  `*.ts.net`: sensitive commands are guarded in Rust.
- [ ] #5 LAN pairing fingerprint out of band: not done.
- [ ] #9 restore maintenance mode: waits for the Batch 1 patch (api/backup.ts).

## Batch 1 patch (other session, which has ended)
`.claude/worktrees/batch1/batch1.patch` (17 files) and `scripts-0600.patch` (needs
`git apply --directory=scripts`). Both checked with `git apply --check` against this
checkout: they apply cleanly. Not applied: the session asked for the user to apply them.

| Command | Scope | Result |
|---|---|---|
| new tests before each fix | sink retry, manual sync, lease ×2, >5000 import, stand-in, self-hosted ×2, store limits | failed for the expected cause |
| `cargo test --locked`, `cargo clippy --locked --all-targets -D warnings` | src-tauri | 20/20, clean |

## Full gates (shared checkout, end of this round)
| Command | Result |
|---|---|
| `pnpm lint && pnpm check` | pass |
| `pnpm test` | 2192/2192 (169 files) |
| `PROVIDERS_READ_ONLY=1 JIRA_READ_ONLY=1 pnpm test:e2e` | 181/181 (was 163) |
| `pnpm test:smoke` | fails as on main before this work: entry chunk 945 KiB > 925 budget (not raised) |
| `cargo test --locked`, `cargo clippy --locked --all-targets -D warnings` | pass |

## Round 2 (user: "proceed")
- [x] Batch 1 patch and scripts-0600 patch applied (they applied cleanly). `api/i18n.test.ts`:
  its request now meets activation's earlier refusal ("no account to activate"). It still
  checks the locale header, with that message.
- [x] #9 Restore: maintenance mode (`api/lib/maintenance.ts`). Writes answer 503
  (`server.maintenance`), except batches made only of `backup.*`; syncs and sink passes don't
  start; syncs under way are waited for. A failure after the backup went in brings the safety
  copy back. If that fails too, the server stays closed to writes (`server.backup.stuck`).
- [x] `MODULES_TRUST_EXTRA_KEY` ignored in production unless
  `MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION=1` (e2e store/modules and `studio/lib.mjs` pass it).
- [x] axe gate `e2e/a11y.test.mjs` on 7 routes (WCAG 2/2.1 A/AA, serious/critical). Fixed: the
  sidebar's theme switch nested a button (now `SwitchLook`), and Settings nav contrast.
  Manual keyboard/screen-reader passes stay for releases.
- [x] Entry chunk under its budget: Italian texts on demand (`contracts/i18n/client.ts`,
  swapped in by vite.config.ts for the page only). 945 → 847.7 KiB, 300.5 → 268.8 gzip.
  `test:smoke` passes again.
- [x] Compression: precompressed static assets (`scripts/precompress.mjs`, served
  `precompressed`), gzip on `/api/trpc/*`, never on `/api/events`.
- [x] `issues.favorites`: the sidebar (every page) no longer loads the whole catalogue.
- [x] `cargo fmt`: `src-tauri/rustfmt.toml` (max_width 140, heuristics Max: the fewest
  changes); formatted once.
- [x] CI: read-only permissions, actions pinned by SHA. New jobs: e2e (Postgres service,
  read-only), native (fmt, clippy, test on macOS), Docker run (health, SPA, migrations,
  pg_dump), audit (prod, high). Dependabot for npm, cargo, docker, gradle.
- [x] Public docs: SECURITY.md, CONTRIBUTING.md (e2e prerequisites, code of conduct),
  issue/PR templates; README privacy corrected (store, Open-Meteo).
- [x] Dependencies: Zod 4.6.7, Hono 4.13.13, @hono/node-server 1.19.17, react-router 7.18+,
  Vite 7.3.7, Vitest 4.1.12, PostCSS; transitive advisories raised within their major
  (pnpm-workspace.yaml overrides). `pnpm audit --prod`: clean. `pnpm audit`: 2 left, accepted:
  postcss-selector-parser 6 (Tailwind 3, no fixed 6.x, build time only), esbuild dev server (low).
- [x] Version: one source, `package.json` 0.1.0; tauri.conf.json reads it; scripts read it.
- [x] Base images pinned by digest (Dockerfile, deploy/staging.yml db). CHANGELOG.md.
- [x] Image: PGlite, TypeScript, better-sqlite3 removed from the runtime image (better-sqlite3 a
  dev dependency now). node_modules 110 → 40 MB, image 68.5 MiB; booted on Postgres.
- [x] Staging updated with `pnpm docker:update`: migration 0010 applied, healthy, jtt unchanged.
- [x] `issues.unreadCount`: the sidebar counter no longer loads the catalogue. Before/after
  table in docs/dev/performance.md (cold page ~1.6 MB → ~450 KiB, warm 220–430 → 12–21 KiB).
- [x] LAN pairing: the fingerprint is compared with what the phone shows for the certificate,
  not with the page (app and welcome page texts, en/it).
- [x] Board: 50 cards per column at first, "Show N more" adds 50 (e2e).
- [ ] Release signing/notarization, Android release key: need the user's accounts and keys.
- [ ] Rollback rehearsal on the stack (`--rehearse-rollback`): drops and restores the inkledger
  database, so the user runs it.
