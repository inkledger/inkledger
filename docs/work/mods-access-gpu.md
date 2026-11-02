# State (done, mods not yet signed): mods access per user and per mod, no freeze on PCs without a GPU

## Goal and done criteria
- New users start with no mods; an admin (or a user manager holding them) grants mods one by one.
- Existing users keep what they run today.
- No whole-browser freeze on PCs without a usable GPU: the host tells mods when rendering is software; Bonsai stops WebGL there and its film made ahead stops when the tree is gone; Citywindow goes still on software rendering and slows down when frames cost too much; Board cards no longer animate box-shadow.

## Constraints and out of scope
- Never rewrite a migration on disk or a shipped data migration; mods stay 1.0.0; no signing/publishing to the Store without explicit OK; tests with PROVIDERS_READ_ONLY=1; public repo: English, no personal data.

## Decisions
- Per-mod grants in `users.module_grants` (JSON ids, migration 0037), on top of the `useModules` permission: a member runs a mod when it holds useModules and the mod is granted (`mayRunModule`, api/queries/accounts.ts); an admin runs all.
- `modules.list` still lists every module (the Store manages them) plus `granted`; ModuleHost runs only those. Storage/files/totals procedures and the module file route refuse a module not granted.
- In the UI the useModules checkbox is replaced by one checkbox per installed module; granting one sets useModules, removing the last one clears it.
- Only new users change (DEFAULT_PERMISSIONS = []); data migration `module-grants-for-existing` grants today's installed mods to members already holding useModules (their own off switches still apply).
- Who may grant: unchanged (`within`), extended to modules: a non-admin grants only modules it runs itself.
- Software rendering: `src/modules/render.ts`, once per page (WebGL with failIfMajorPerformanceCaveat + renderer name; override localStorage `inkledger-render`), passed as `ThemeState.softwareRender` (optional, older hosts don't say).
- Bonsai on software rendering: card drawn by its CPU renderer in the worker (no WebGL), no perch tree, no film made ahead, film player can't make frames. Film made ahead: only while a tree is mounted, stopped (between frames, timer cleared) when the last one goes.
- Citywindow: software rendering → still view (as reduced motion); frame budget: two slow judgements in a row (avg draw > 10 ms or gap p95 > 2× budget, every 120 frames) step 60→30→15→still.

## Batches
- [x] 1. Access per user and mod (schema, migration, rule, routers, UI, i18n, parity, tests)
- [x] 2. Host: software rendering detection, no box-shadow transitions on cards
- [x] 3. Mods repo: Bonsai, Citywindow (sync-types, build unsigned, e2e mods-real) — not signed, not published

## Checks
| Command | Scope | Result |
| ------- | ----- | ------ |
| `pnpm vitest run contracts/accounts.test.ts api/routers/auth.test.ts api/modules/modules.test.ts api/routers/users-race.test.ts` | grants, within, list/storage/file gate, data migration | 68 pass |
| `pnpm vitest run api/queries/schema-drift.test.ts api/queries/migrations.test.ts` | migration 0037 | pass (draft-0010 test undoes the new column) |
| `node --test e2e/accounts.test.mjs` (PROVIDERS_READ_ONLY=1) | invite: no mods by default, one granted | 2 pass |
| `pnpm vitest run src/modules` | render detection + host | 14 pass |
| mods repo `pnpm typecheck && pnpm test` | all mods + new citywindow test (fails without the fix) | 304 + 1 pass |
| `MODS_BUILD=… node --test e2e/mods-real.test.mjs` | six real mods, unsigned build | 5 pass |
| headless probe (SwiftShader = software) | Bonsai card engine cpu in worker, no perch; `gpu` override draws the perch | ok |
| `pnpm lint && pnpm check && pnpm test && pnpm test:smoke` | host | pass (2821 tests) |
| `PROVIDERS_READ_ONLY=1 pnpm test:e2e` | host e2e | 347/348; the Vite-dev one read DEV_HOST from .env → harness pins DEV_HOST=127.0.0.1; `e2e/screensaver.test.mjs` 4/4 after |

## Blocks and next action
- Signed builds of Bonsai and Citywindow for the real server: through the Store flow, only with the user's OK.
- On the affected PC: `edge://gpu`, then Board and Month with mods granted one by one.
