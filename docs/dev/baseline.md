# Baseline

The state the consolidation starts from, to compare against. [measuring.md](measuring.md) says how
every number is taken. Durations are left out on purpose: they vary between machines and runs.
The scenario names behind the counts are in [baseline-scenarios.json](baseline-scenarios.json):
no scenario may disappear without being covered somewhere else, said in the commit.

## Environment

| Tool | Version |
|---|---|
| Node | 24.x |
| pnpm | 11.2.2 |
| TypeScript | 5.9.3 |
| Vite | 7.3.6 |
| Vitest | 4.1.10 |
| React | 19.2.7 |

## Gate

`pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke && PROVIDERS_READ_ONLY=1 pnpm test:e2e`

| Step | Result |
|---|---|
| lint | pass |
| check | pass |
| test | pass |
| build | pass |
| smoke | pass |
| e2e | pass |

Unit: 1893 tests in 127 files. E2E: 107 scenarios in 19 files.

## Bundle

| Chunk | KiB | KiB gzip |
|---|---:|---:|
| entry `index.js` | 1067 | 333.6 |
| first load (entry + preloads + css) | 1166.6 | 352 |
| all JS (38 chunks) | 1426.2 | 443.8 |
| all CSS | 99.7 | 18.4 |

Entry chunk: 1092568 bytes (341620 gzip).

## Queries per sync pass (20 entries, fake tracker)

| Pass | Queries |
|---|---:|
| all new | 80 |
| all known (full re-read) | 80 |
| five gone | 10 |

## Parity inventories

| Inventory | Count |
|---|---:|
| tRPC procedures | 185 |
| Routes | 13 |
| Settings sections | 15 |
| i18n keys (en / it) | 2166 / 2166 |

## Tests per file

### Unit

| File | Tests |
|---|---:|
| `api/app.test.ts` | 41 |
| `api/appBuild.test.ts` | 2 |
| `api/attachments.test.ts` | 12 |
| `api/backup.test.ts` | 5 |
| `api/downloads.test.ts` | 5 |
| `api/events.test.ts` | 2 |
| `api/hooks.test.ts` | 3 |
| `api/i18n.test.ts` | 4 |
| `api/icons.test.ts` | 5 |
| `api/query.test.ts` | 9 |
| `api/serverHosts.test.ts` | 5 |
| `api/syncScheduler.test.ts` | 9 |
| `api/transfer.test.ts` | 1 |
| `api/worklogSync.test.ts` | 4 |
| `api/jira/client.test.ts` | 21 |
| `api/jira/readonly.test.ts` | 1 |
| `api/lib/crypto.legacy.test.ts` | 1 |
| `api/lib/crypto.test.ts` | 6 |
| `api/lib/env.test.ts` | 3 |
| `api/lib/history.test.ts` | 2 |
| `api/lib/links.test.ts` | 3 |
| `api/lib/password.test.ts` | 3 |
| `api/lib/placement.test.ts` | 22 |
| `api/lib/security.test.ts` | 35 |
| `api/lib/time.test.ts` | 25 |
| `api/lib/workSchedule.test.ts` | 6 |
| `api/modules/activation.test.ts` | 5 |
| `api/modules/modules.test.ts` | 26 |
| `api/parity/parity.test.ts` | 6 |
| `api/providers/catalog.test.ts` | 2 |
| `api/providers/catalogMatrix.test.ts` | 2 |
| `api/providers/connections.test.ts` | 3 |
| `api/providers/schemas.test.ts` | 5 |
| `api/providers/selfHosted.test.ts` | 6 |
| `api/queries/containers.test.ts` | 3 |
| `api/queries/credentials.test.ts` | 2 |
| `api/queries/migrations.test.ts` | 7 |
| `api/queries/schema-drift.test.ts` | 2 |
| `api/queries/writeRules.test.ts` | 5 |
| `api/routers/auth.test.ts` | 25 |
| `api/routers/buckets.test.ts` | 8 |
| `api/routers/clients.test.ts` | 3 |
| `api/routers/connections.github.test.ts` | 15 |
| `api/routers/connections.test.ts` | 5 |
| `api/routers/idor.test.ts` | 4 |
| `api/routers/issueNotes.test.ts` | 4 |
| `api/routers/issues-categories.test.ts` | 2 |
| `api/routers/issues-create.test.ts` | 3 |
| `api/routers/issues-organize.test.ts` | 20 |
| `api/routers/issues-people.test.ts` | 4 |
| `api/routers/issues-query.test.ts` | 5 |
| `api/routers/issues-search.test.ts` | 4 |
| `api/routers/issues-transitions.test.ts` | 2 |
| `api/routers/issues-watch.test.ts` | 3 |
| `api/routers/notifications.test.ts` | 14 |
| `api/routers/pinboard.test.ts` | 7 |
| `api/routers/queries.test.ts` | 2 |
| `api/routers/remoteLinks.test.ts` | 1 |
| `api/routers/settings.test.ts` | 3 |
| `api/routers/timers.test.ts` | 13 |
| `api/routers/two-connections.test.ts` | 13 |
| `api/routers/workSchedule.test.ts` | 4 |
| `api/routers/worklog-scope.test.ts` | 3 |
| `api/routers/worklogs-registry.test.ts` | 7 |
| `api/routers/worklogs-team.test.ts` | 3 |
| `api/routers/worklogs.test.ts` | 12 |
| `api/store/store.test.ts` | 9 |
| `api/sync/companion.test.ts` | 7 |
| `api/sync/engine.test.ts` | 10 |
| `api/sync/extraSinks.test.ts` | 3 |
| `api/sync/jira-gate.test.ts` | 3 |
| `api/sync/queries-per-pass.test.ts` | 2 |
| `api/sync/timeWrites.test.ts` | 6 |
| `api/sync/worklogs.test.ts` | 8 |
| `api/weather/openMeteo.test.ts` | 3 |
| `src/hooks/usePeriod.test.ts` | 4 |
| `src/lib/boardDone.test.ts` | 2 |
| `src/lib/boardTargets.test.ts` | 3 |
| `src/lib/browserSupport.test.ts` | 1 |
| `src/lib/csv.test.ts` | 2 |
| `src/lib/devices.test.ts` | 3 |
| `src/lib/gapCuts.test.ts` | 8 |
| `src/lib/issueWorklogs.test.ts` | 4 |
| `src/lib/issues.test.ts` | 3 |
| `src/lib/native.test.ts` | 2 |
| `src/lib/pinboardString.test.ts` | 4 |
| `src/lib/pinboardView.test.ts` | 3 |
| `src/lib/projectColors.test.ts` | 3 |
| `src/lib/queryAssist.test.ts` | 1 |
| `src/lib/recap.test.ts` | 3 |
| `src/lib/urlCodecs.test.ts` | 2 |
| `src/lib/utils.test.ts` | 1 |
| `src/lib/wallHours.test.ts` | 1 |
| `src/modules/appEvents.test.ts` | 1 |
| `src/modules/hit.test.ts` | 5 |
| `api/providers/asana/adapter.test.ts` | 59 |
| `api/providers/azure/adapter.test.ts` | 54 |
| `api/providers/basecamp/adapter.test.ts` | 65 |
| `api/providers/clickup/adapter.test.ts` | 63 |
| `api/providers/clockify/adapter.test.ts` | 51 |
| `api/providers/everhour/adapter.test.ts` | 24 |
| `api/providers/core/core.test.ts` | 10 |
| `api/providers/core/http.test.ts` | 2 |
| `api/providers/core/operations.test.ts` | 2 |
| `api/providers/core/translate.test.ts` | 2 |
| `api/providers/fake/adapter.test.ts` | 30 |
| `api/providers/gitea/adapter.test.ts` | 36 |
| `api/providers/gitlab/adapter.test.ts` | 67 |
| `api/providers/github/adapter.test.ts` | 16 |
| `api/providers/harvest/adapter.test.ts` | 46 |
| `api/providers/jira/adapter.test.ts` | 19 |
| `api/providers/linear/adapter.test.ts` | 34 |
| `api/providers/monday/adapter.test.ts` | 42 |
| `api/providers/notion/adapter.test.ts` | 50 |
| `api/providers/openproject/adapter.test.ts` | 53 |
| `api/providers/plane/adapter.test.ts` | 66 |
| `api/providers/redmine/adapter.test.ts` | 58 |
| `api/providers/planner/adapter.test.ts` | 59 |
| `api/providers/shortcut/adapter.test.ts` | 44 |
| `api/providers/todoist/adapter.test.ts` | 46 |
| `api/providers/tempo/adapter.test.ts` | 38 |
| `api/providers/toggl/adapter.test.ts` | 43 |
| `api/providers/trello/adapter.test.ts` | 40 |
| `api/providers/wrike/adapter.test.ts` | 52 |
| `api/providers/youtrack/adapter.test.ts` | 42 |
| `src/lib/theme/derive.test.ts` | 11 |
| `api/providers/core/richtext/richtext.test.ts` | 64 |

### E2E

| File | Scenarios |
|---|---:|
| `e2e/accounts.test.mjs` | 1 |
| `e2e/board.test.mjs` | 8 |
| `e2e/buckets.test.mjs` | 2 |
| `e2e/connections.test.mjs` | 2 |
| `e2e/create-issue.test.mjs` | 1 |
| `e2e/github-time.test.mjs` | 1 |
| `e2e/issue-links.test.mjs` | 2 |
| `e2e/modules.test.mjs` | 24 |
| `e2e/parallel.test.mjs` | 1 |
| `e2e/pg-import.test.mjs` | 1 |
| `e2e/reconnect.test.mjs` | 1 |
| `e2e/regressions.test.mjs` | 47 |
| `e2e/search-memory.test.mjs` | 3 |
| `e2e/store.test.mjs` | 7 |
| `e2e/surfaces.test.mjs` | 1 |
| `e2e/timer-lock.test.mjs` | 2 |
| `e2e/transitions.test.mjs` | 1 |
| `e2e/trash.test.mjs` | 1 |
| `e2e/worklogs.test.mjs` | 1 |
