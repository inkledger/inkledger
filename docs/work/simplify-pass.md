# Status: whole-project /simplify pass

## Goal and completion criteria

Quality-only pass over the whole repository: reuse, simplification, efficiency and altitude.

- Behaviour stays unchanged.
- The full gate is green.
- Bugs found along the way are recorded as leads for `/code-review`, not fixed here.

## Constraints and out of scope

Out of scope:

- `drizzle/` and migrations
- `api/vendor`
- generated parity JSON
- `studio/`
- i18n text

Rules:

- No public contract changes.
- No assertion is weakened.

## Method

- Three read-only reconnaissance passes (providers, server and contracts, client) produced the leads.
- One agent per slice then worked in its own worktree and committed once per batch.
- Each agent re-read the code before every change and skipped anything that would alter behaviour.
- The batches were cherry-picked onto `main` with no conflicts.

## Batches

| Slice | Commits | What |
|---|---|---|
| C — client | 38b07e7..cdb410d (5) | Palette, timer-log and make-TODO hosts are lazy, and the closed palette holds no queries. Pinboard and Board render less often. Shared hooks and stores: `createStore`, `useMediaQuery`, `useInvalidateIssues`, `useDeviceFlow`. Shared date and total helpers. Workspace mutations are created only where they are used. Dead exports removed. |
| S — server | 701def4..c539601 (5) | Shared time, hash, `callMeta`, JSON-list, ownership, lock and position helpers. `pinOnce` and a revision-checked note write. Generic issue sync queries per full pass drop from 2n+4 to a constant 5 (new issues) and from 2n+2 to 3 (known issues); `api/sync/issues-queries.test.ts` checks this. Fewer and parallel reads in issues, pinboard, forecast and connections. Dead code removed. |
| P — providers | 2b3d0df..8e29a31 (6) | Shared HTTP call, refusal reading, Retry-After, `collectPages` and `mustAnswer`. Options, categories, webhook and path helpers. Markdown→HTML writers share one module; output is byte-identical across 11 writers × 42 inputs, with a golden test. Shared time helpers and `simRequest` in 22 simulators. Wrike makes one GET fewer per transition. 92 local-only exports dropped. Net −440 lines. |
| T — e2e and scripts | d7ccff4, 7f0c61b (2) | `dayKey`, `lastWorkday` and `AXE` live in `e2e/harness.mjs`. Unsigned-mods signing is shared by `mods-real` and `lighthouse`. |

First-load JS: 924.5 / 293.9 KiB before, 852.2 / 270.8 KiB after (budget 925 / 295).

## Skipped (would change behaviour, or churn)

- **Settings and forms:**
  - `useSettings` wrapper: different `staleTime` per site.
  - `useSettingsForm` on `useSettingsSave`: different semantics.
- **Client components:**
  - One `relativeTime`: rounding and thresholds differ.
  - `issueKeyActions`, `FloatingWidget`, `DeviceCodePanel` markup, `ExternalLink`, `copyText`, the Pinboard switcher `Button`.
  - One `mobile-tabs` provider.
  - The screensaver clock.
- **Validation and dates:**
  - `localDateSchema` in notes, mails, todos, workSchedule and issues: the shared schema would be stricter, or the error text would change.
  - `parseDayKey` in `contracts/query.ts`: it rejects month 13, which today rolls over.
- **Server:**
  - `syncOneConnection`: the route and the orchestrator differ in three ways.
  - `worklogs.update` single read: there is a gap around the lease.
  - `issues.reorderFavorites` batching: last-write-wins across rows.
  - The purge registry.
- **Providers:**
  - basecamp `nextLink`: its regex is looser.
  - Refusal parsing in 8 providers with other message shapes.
  - `jsonCall` for azure, github and gitlab.
  - toggl `dayStart`: 7 days differ in zones that skip midnight.
  - tempo `instantOfWall`, clockify `nextDay`, `dayOfDateText`.
  - Shared simulator `json` and a controls mixin.
  - The shortcut states map.
  - Jira worklog id fetches stay sequential (rate budget).
- **e2e and scripts:**
  - Fixed sleeps in e2e: they check that nothing happened, and they cannot be proven safe without a run.
  - The Docker and deploy scripts.

## Small known differences, accepted

- **Palette:** when closed it no longer keeps its queries alive. After more than 5 minutes closed, reopening may briefly show loading.
- **Timer-log dialog:** a timer stopped within about 1.5 s of page load shows its dialog once the chunk arrives, as QuickStart does.
- **`connectionOptions`:** stored non-object options read as `{}`. Before, `null` crashed. The app only writes objects.
- **Issue sync:** a database failure mid-page now writes nothing of that page. The pass failed before too, and the checkpoint does not advance.
- **Wrike list and apply on a missing task:** they also make the `/workflows` GET, now run in parallel.
- **Retry-After:** a non-finite value now uses the fallback wait.

## Leads for /code-review (not fixed here)

- `api/queries/todoSessions.ts`: end of day is computed as start + 24h − 1, which is wrong on DST days.
- `issues.toggleFavorite` and the timers both take `pg_advisory_xact_lock(userId)` with the same key, so they serialise against each other.
- `issues.syncConnection` and the orchestrator's pass differ:
  - the route never calls `syncInbox`;
  - the route answers CONFLICT when the stream is busy;
  - the route does not catch per-connection errors.
- `issues.ts` field date: an invalid value surfaces as a 500, not a 400.
- `contracts/query.ts` `daySpan`: month 13 rolls over to the next year.
- `routers/modules.ts:132`: signature verification depends on a sort that uses `localeCompare`.

## Checks

| Command | Scope | Result |
|---|---|---|
| `pnpm check`, `pnpm lint`, vitest per batch | each slice, in its worktree | pass |
| `pnpm build && PROVIDERS_READ_ONLY=1 pnpm test:e2e` | after C | 321/321 |
| `pnpm check && pnpm lint && OLLAMA_URL= pnpm test` | C + S | 2708 pass |
| full gate | C + S + P | unit 2714, smoke ok (852.2 / 270.8), db:check ok; e2e 320/321 |
| that one e2e, alone ×3 | Studio geometry | pass ×3 |
| `pnpm lint && PROVIDERS_READ_ONLY=1 pnpm test:e2e` | final main (C+S+P+T, test fix) | 321/321 |

The Studio geometry test measured the canvas while it was still loading, so it failed under concurrency. It now waits for the canvas to settle (`quiet`) before measuring.

## Status

Complete. Nothing is pushed; the user pushes.
