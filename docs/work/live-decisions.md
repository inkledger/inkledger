# Status: shared decisions across every client of a user

Plan: `~/.claude/plans/dobbiamo-capire-come-comportarti-flickering-garden.md` (approved 2026-11-04).

## Goal and done criteria
Every page, browser, the native app and the phone show the same decision state. A decision modal open on one client also appears on the others and on any page opened later. The draft is shared live. The first answer wins, and the other clients are told who answered. Done when batches 1–11 are merged with the full checks green.

## Constraints and out of scope
- Locks stay in Postgres (advisory + CAS). No Redis for locks; Redis is optional later, for pub/sub only.
- Never rewrite migrations. Tests always run with `PROVIDERS_READ_ONLY=1`. Dev :3000 first, never the prod stack.
- Out of scope: a decisions API for paid modules. Mods stay at 1.0.0.

## Decisions (user, 2026-11-04)
- All copies are active; the first answer wins and the others see "decided elsewhere".
- The draft is live (300 ms debounce) and stored on the server.
- Scope: every client, phone included; everything that makes sense to sync, including in-flight actions.
- Time not logged stays paused. Discarding an outbox entry that came from a timer gives the time back to the timer.
- A user who is typing gets a banner first, then the modal.
- Reminders: one per user, closed everywhere; the system notification fires once.
- Inline editors get a "resume here" banner, with no forced navigation.
- Ephemeral tables are left out of backups; a restore clears them.
- A manual free log (no timer) is shared too, as `span-log`.

## Batches and progress
- [x] 0 Spike (worktree and branch removed after landing)
- [x] 1 Plumbing — `contracts/liveEvents.ts` (shared union + listener list), `origin` on every event, `serverNow` offset (`liveEvents.serverNow()`), table-driven `useLiveSync` coalescing refetches (16 ms timeout, works in background tabs too)
- [x] 2 Core — `reconcile` (abandoned answer → open, or obsolete "logged" if its timer's time was taken), `purgeDecisions` at boot (7 days), restore clears `decisions` in `signOutAfterRestore`, IDOR → NOT_FOUND, drop-list in migrations test, parity updated, lock order documented in `api/queries/locks.ts`. Favorite advisory key left as is (repo rule: never change a lock key; contention negligible)
- [x] 3 timer-log (Tauri check by the user still open) — done: server opens it on stop/switch/TODO (both paths), ends it on resume or on a log made another way, rest < 60 s goes and a bigger rest stays paused with no new question (user), "Later" keeps the draft comment as the timer note, `askTimerLog` for "to log" and the timeline, SSR prefetch, mobile sheet yields, banner-then-modal while typing. Also: draft typing no longer bumps the question's revision (an answer right after a keystroke elsewhere stands), the draft is flushed before "Later", the page that answered hides it at once, no `?client=` on the stream until presence uses it. First load: the own lazy-loading commit was dropped at the rebase, the second simplify pass (0da6811) already makes the notification body and mobile sheets lazy (898.1 KiB).
- [ ] 4 idle
- [ ] 5 start
- [ ] 6 confirm
- [ ] 7 data push
- [ ] 8 reminders
- [ ] 9 busy/presence
- [ ] 10 forms
- [ ] 11 edit-session
- [ ] 12 (optional) cross-process

## Spike findings (batch 0)
What was built:
- SSE `id:` `run:seq` plus a per-user ring buffer of 500 events, replay on `Last-Event-ID`, and `hello{serverNow, resync}`.
- `decisions` table (JSON as text, per schema convention; partial unique index on open/resolving).
- `api/decisions/store.ts`: open/merge, end on resume or on a log made another way, draft patch with last writer per field, `answer()` (claim open→resolving at the seen revision, then run, then resolved or back to open with `lastError`).
- `decision` on `worklogs.create`.
- `x-client-id` and `clientId()` in memory.
- Spike `DecisionHost` reusing `LogTimeDialog` (`shared` prop).

Validated:
- The model holds. "First answer wins" with two pages answering concurrently gives one worklog and one `decision:busy|decided` refusal; a late answer is refused before anything is written.
- The SSE replay works in Hono as is (no proxy in dev; compression does not touch `/api/events`).
- Two browser contexts plus a page opened later all show the modal. The draft goes from A to B within the timeout. B's answer closes A and the late page with "Logged on …". The answering page is not told. One worklog with the shared comment, timer cleared.

Learned (to fold into the real batches):
- `subscribe()` listeners now get `{seq, e}`: update every test subscriber (`timers`, `workSchedule`, `notes`, `buckets` tests).
- Every new table goes into the drop list of `api/queries/migrations.test.ts` (draft-0010 replay).
- New procedures need `pnpm parity:update` with an explained change.
- React lint forbids `setState` in effects: draft merge and "ended elsewhere" use the derived-state-during-render pattern.
- `LogTimeDialog` close: the dialog calls `onClose` after a save too. "Later" must only fire when no save happened (`onDone` sets a flag; the close is checked on the next tick).
- The note-copy on "Later" is not done in the spike (server-side dismiss effect still to build).
- The unlinked `todos.startWork` path still opens no decision.

Not validated in the spike (stated, not assumed):
- The Tauri webview reconnect with `Last-Event-ID`: needs a manual check in the app.
- Smoothness measurement (`perf.mjs`).
- The browser's automatic EventSource reconnect replay (covered server-side by a unit test only).

## Checks
| Command | Scope | Result |
| --- | --- | --- |
| `npx vitest run api/events.test.ts` | SSE replay/resync | 4/4 pass |
| `npx vitest run api/decisions/decisions.test.ts` | decisions model | 7/7 pass |
| `npx vitest run api/routers/timers.test.ts api/routers/workSchedule.test.ts api/events.test.ts` | touched routers | 26/26 pass |
| `pnpm check`, `pnpm lint` | spike worktree | pass |
| `pnpm build && PROVIDERS_READ_ONLY=1 node --test e2e/decisions.test.mjs` | two devices + late page | 1/1 pass |
| `pnpm test` | full suite on spike | 4 fail (expected: subscriber shape ×2, parity inventory, migrations drop-list), 3147 pass |
| `pnpm test:smoke` on main e5f8fec | first-load budget | already over: 926.8 KiB > 925 (pre-existing) |
| `pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke && PROVIDERS_READ_ONLY=1 pnpm test:e2e` | batches 1–3 | all pass: 3157 unit, 446 e2e, first load 898.9 KiB / 285.1 gzip |
| same chain | batches 1–3 rebased on 0da6811 (simplify pass) | 3162 unit, smoke 898.1 KiB; e2e 446/447: `virtual-lists` Quick start failed during work hours on every base (also e5f8fec), fixed in the test (`isVisible` does not wait); then 3/3 |

## Blocks and next action
- Spike kept as the base for batches 1–3 (user, 2026-11-04): it is refined in the same worktree, and only verified batches go to main, one commit each (commits only on the user's OK).
- Tauri webview reconnect: checked by the user by hand at the end of batch 3 (steps to be given).
Next: Tauri check on dev :3000 by the user, then batch 4 (idle).
