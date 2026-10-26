# Status: consolidation, UX and mods/Store/Lighthouse plans

Plans: the audit's `hulkling-namor-wasp.md` (UX) and `argent-green-lantern-green-lantern.md`
(mods, Store, Lighthouse). The technical plan is in consolidation-batch0.md.

## Constraints
No push, deploy, signing, publishing or real services; test servers with PROVIDERS_READ_ONLY=1,
JIRA_READ_ONLY=1; mods stay 1.0.0; never `pnpm build` in inkledger-modules (it signs).

## UX
- [x] UX-A (32822c9): a day with entries takes one more on that day; the header says "today";
  Day/Week/Month keep the period; trackers' search starts from the local query; Board column
  → catalogue on its status and done ones; Days export waits for the days.
- [x] UX-B (70e5ac8): dirty-close guard, palette timer actions, Retry on start, 44 px day rows,
  Timesheet bulk select with progress.
- [x] UX-C (6c92e37): full-strength focus rings (lint rule + 3:1 test), TransitionDialog named in
  every state and focus on the first refused field (loading branch by review), PeriodBars table
  equivalent, roving radio groups (SegmentedControl, theme presets), PeriodPicker plain buttons,
  app-wide reduced motion, one loading status (skeletons aria-hidden, by review), coarse-pointer
  44 px tap areas, Reports mobile sort + entry label.
- [x] UX-D (6c92e37): localized back hint and platform keys, toaster labels, trash copy, settings
  synonyms, docs/dev/ux-patterns.md. README screenshots NOT regenerated: studio's reseed writes
  inkledger_demo in the jtt-db Postgres (prod instance) — left to the user.
- [x] f33b8a7: live timer controls inside the day chart just past midnight; weekday-independent tests.

## Mods (app side)
- [x] 57ef404 MOD-P1-04 timer-started by connectionId:key; MOD-P1-05 async-safe guard, reads of a
  stopped module stay unanswered.
- [x] 0dcb7ef MOD-P1-07 advisory-locked caps (60 parallel writers, real Postgres e2e);
  MOD-P1-06 revisions (0011), storageSetIf, optional host `storage.update` (CAS + replay),
  import bumps revisions.

## Mods (inkledger-modules)
- [x] 0d4f5f3 MOD-P1-01/02 per-account reload (Desk Radio, Bonsai prefs/pictures/film);
  MOD-P1-03 worker jobs settle, bitmaps closed (Bonsai, City Window); MOD-P1-05 late async ignored;
  MOD-P1-06 all six mods save through `shared/saved.ts` (ops replayed, events counted once).
- [x] 3ebec0f M3 a11y: MOD-P1-08 Stitch sheet, P1-09 Bonsai film, P1-10 Kanbunny focus, P2-11..13
  (roving groups, locked rewards reachable, search status, host font, retried saves, Shadow weather
  opt-in); e2e on the real modules (40e5e3a, e2e/mods-real.test.mjs).
- [x] 7563421 M4 Store Worker: Ledger DO (atomic fulfilment), accessible pages, /claim cookie,
  body caps, fail-closed config, limiter, README/catalog truth. Needs the LEDGER binding at deploy.
- [x] 41448af M5 CI + unsigned reproducible build ×2.
- [x] Lighthouse: harness (116a822, 3efff82, 88d1f25), baseline and final matrix in
  docs/dev/performance.md. A11y/BP/SEO 100 in all 186 runs; mobile Performance 100 left out by the
  owner's decision (needs SSR).
- [x] 93c521f migration 0010 idempotent (a draft had run on the dev database).

Status: complete, except mobile Performance 100 (decided out of scope).

## Verifications
| Command | Scope | Result |
| ------- | ----- | ------ |
| pnpm lint/check/test/build/test:smoke | app after UX-C/D | pass (2216 unit) |
| PROVIDERS_READ_ONLY=1 pnpm test:e2e | app after UX-C/D | 203/204, the 1 fixed (sub-pixel) and rerun |
| e2e/modules.test.mjs | app after CAS/locks | 26/26 |
| pnpm typecheck && pnpm test | inkledger-modules after M1 | 266/266 |

## Open
- Commit f33b8a7's subject is 55 chars (rule ≤50); left as is (no history rewrite).
- Manual: VoiceOver/NVDA, physical devices, Desk Radio listening pass.
- Owner: LEDGER Durable Object binding on the next Store deploy; README screenshots (studio writes
  to the prod Postgres instance); restart the dev server after 93c521f.
