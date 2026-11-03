# State: UI density, workflow and FlowMap baseline — partial: B0, BF0, B2A, B2B, B1, layout-safe BF done and verified; waiting for a week of baseline

## Goal and done criteria
Fit the information better on every page: primary content above the fold, each figure once, coherent workflows, every page measurable by FlowMap.

Execution order (authoritative):
1. B0 measured audit
2. BF0 measurement blockers and severe regressions
3. B2A FlowMap collection correctness
4. B2B additive instrumentation of the current layout
5. ~1 week baseline
6. B1 shared UI foundations
7. B3 one page at a time with visual review
8. BW workflows
9. B4 cleanup

**B0** (this batch) changes no UI. Its done criteria:
- measured numbers per page and viewport;
- confirmed or rejected hypotheses;
- before/target wireframes;
- a proposed BF0 scope.

## Constraints and out of scope
- **No code changes in B0.** No production UI changes, no `pnpm parity:update`, no migrations, no catalog version change, no commits.
- **Audit only on the demo database.** It runs on `inkledger_demo` and never on dev or prod. Only reads are allowed: every non-GET request is blocked and logged.
- **Frozen files.** Files owned by work still open are frozen (see the last section).
- **English only.** This doc follows the repo rule.

## Environment (verified)
| Item | Value | How |
| --- | --- | --- |
| Commit | `3d58c4c` (main, clean) was built and measured. The day-hours work landed first (`006f898`). Main moved to `a954351` during B0, with Desk chat changes only. | `git log`, `git status` |
| Tests before B0 | Green on `006f898`, the same tree as `3d58c4c` except one doc: lint, check, unit 2971/2971, build, smoke, e2e 394/394 (`PROVIDERS_READ_ONLY=1`) | Run in the day-hours worktree before the merge |
| Demo database | `127.0.0.1:54331/inkledger_demo`, on the **test** Postgres cluster | `STUDIO_DATABASE_URL`; guard in the driver checks port 54331 and `current_database() = inkledger_demo` |
| Why not the default | `studio/lib.mjs` takes `DATABASE_URL` from `.env`, which is `127.0.0.1:54329`, the production Postgres container, and runs `DROP/CREATE DATABASE inkledger_demo` there. The audit overrides it; see the BF0 proposal. | Code: `studio/lib.mjs adminUrl()/recreateDemoDb()` |
| Seed | `pnpm --dir studio seed`. It writes only through `demoUrl()` (`seed.mjs`, `sources.ts`): Jira 25, GitHub 6, GitLab 5, YouTrack 4 issues, and 20 days of worklogs. | Code inspection plus the resolved target printed before the run |
| Server | `dist/boot.js` from `pnpm build` of `3d58c4c`, `PROVIDERS_READ_ONLY=1`, `JIRA_READ_ONLY=1`, no sync | `studio/lib.mjs startServer()` |
| Browser | Playwright headless Chromium, DPR 1, `timezoneId Europe/Rome`, phones with `isMobile` + `hasTouch` | Every result records `innerWidth`/`innerHeight`/`devicePixelRatio`. A viewport mismatch fails the capture; none failed. |
| State | `theme`, `ikl-locale`, `ikl-density=compact` in localStorage. `ikl-day-end-reminded` is set to today so the after-hours toast does not cover captures. | Init script |
| Periods | The previous full week (from 2026-10-26) and the previous full month (October 2026). The current week and month hold one day of data on a Monday. | URL state: `?period=&from=`, `?day=`, `?from=&to=` |
| Live tracker data | Issue description, comments and links come from a fixture with the current response shape (text plus rich-text `doc`). | Route fixture in the driver |

Tooling: one pipeline (scratch Playwright driver, `audit.mjs` + `probes.mjs`). `studio shots` was not used, because it has fixed 1600×1000 and 390×844 viewports at DPR 2 and 3 and writes into tracked `docs/screenshots/`. Output (gitignored): `studio/out/ui-density/run-*.jsonl` (one JSON per capture), `probes-*.json`, `tables.md`, `shots/*.png` (350 files).

## Execution matrix (as run)
- **Light**: all 19 page states × 5 viewports (1440×900, 1280×800, 1024×768, 390×844, 320×700) × en, it = 190 captures.
- **Dark**:
  - one capture per page state per distinct layout (1280×800 and 390×844, en);
  - every case with any horizontal-overflow signal, again in its locale and viewport.
  - Total: 150 captures.
- **Result**: 340 captures, 0 failed, 0 page errors.
- **Requests**: the only non-GET request seen was `POST issues.markSeen` (19 times, opening an issue). It was blocked, with no page error.
- **Page states**:
  - dashboard: day, week, month;
  - timesheet: week, month;
  - reports;
  - issues;
  - issue detail `APP-214`;
  - board, with the pinboard closed and open (`ikl-pinboard-panel`);
  - notes, ideas, desk, team;
  - settings: account (long) and todos (short);
  - info, pinboard, todos.
- **Probes** (`probes.mjs`, 1280×800 unless stated):
  - period change with delayed responses;
  - keyboard selection under sticky bars;
  - sidebar at 4 heights;
  - input font size on phones;
  - issue detail section order at 3 widths;
  - ViewScope inset;
  - QueryAssist reach (en and it);
  - board columns with the pinboard;
  - Team legend colours;
  - Reports grouping switch.

## Measurement table (all values measured, px, at scroll 0, DPR 1)
Each cell is primary content Y / initial chrome bottom (top bar + page header) / full page height (`#main` scroll height on desktop, document on phones) / viewport scrolls needed to reach the primary content. Primary content per page:
- **Dashboard**: the timeline anchor.
- **Timesheet**: the Days or Month section.
- **Reports**: the Detail section.
- **Issues**: the first issue row.
- **Issue detail**: the Worklogs section.
- **Board**: the first column heading.
- **Notes**: the notes tree.
- **Ideas**: the capture field.
- **Desk**: the empty-state text (the seed has no desk).
- **Team**: the matrix table.
- **Settings**: the first settings group.
- **Info, Pinboard, Todos**: the first section.

**en, light**
| page | 1440x900 | 1280x800 | 1024x768 | 390x844 | 320x700 |
|---|---|---|---|---|---|
| dashboard-day | 112 / 91 / 1930 / 0 | 140 / 119 / 1958 / 0 | 195 / 174 / 3006 / 0 | 266 / 248 / 4424 / 0 | 266 / 248 / 4484 / 0 |
| dashboard-week | 112 / 91 / 1929 / 0 | 140 / 119 / 1957 / 0 | 195 / 174 / 3001 / 0 | 266 / 248 / 4358 / 0 | 266 / 248 / 4400 / 0 |
| dashboard-month | 112 / 91 / 1929 / 0 | 112 / 91 / 1929 / 0 | 195 / 174 / 3001 / 0 | 266 / 248 / 4379 / 0 | 266 / 248 / 4400 / 0 |
| timesheet-week | 735 / 91 / 4239 / 0 | 757 / 91 / 4260 / 0 | 1055 / 135 / 4558 / 1 | 1160 / 215 / 6785 / 1 | 1238 / 272 / 6863 / 1 |
| timesheet-month | 735 / 91 / 2160 / 0 | 757 / 91 / 2181 / 0 | 1055 / 135 / 2480 / 1 | 1181 / 215 / 3120 / 1 | 1218 / 252 / 3157 / 1 |
| reports | 448 / 111 / 1180 / 0 | 448 / 111 / 1180 / 0 | 774 / 153 / 1506 / 1 | 836 / 228 / 2005 / 0 | 836 / 228 / 2005 / 1 |
| issues | 365 / 111 / 2165 / 0 | 395 / 111 / 2195 / 0 | 407 / 153 / 2483 / 0 | 670 / 228 / 5518 / 0 | 709 / 267 / 5948 / 1 |
| issue-detail | 480 / 134 / 900 / 0 | 509 / 162 / 800 / 0 | 2322 / 176 / 768 / 3 | 2517 / 294 / 3547 / 2 | 2793 / 353 / 3838 / 3 |
| board | 183 / 111 / 900 / 0 | 200 / 128 / 800 / 0 | 263 / 191 / 768 / 0 | 353 / 284 / 1054 / 0 | 422 / 321 / 1022 / 0 |
| board-pinboard | 183 / 111 / 900 / 0 | 200 / 128 / 800 / 0 | 295 / 191 / 768 / 0 | 353 / 284 / 1054 / 0 | 422 / 321 / 1022 / 0 |
| notes | 261 / 111 / 900 / 0 | 261 / 111 / 800 / 0 | 300 / 149 / 768 / 0 | 326 / 204 / 878 / 0 | 354 / 204 / 791 / 0 |
| ideas | 170 / 111 / 900 / 0 | 170 / 111 / 800 / 0 | 212 / 153 / 768 / 0 | 245 / 190 / 878 / 0 | 300 / 244 / 734 / 0 |
| desk | 200 / 91 / 900 / 0 | 200 / 91 / 800 / 0 | 200 / 91 / 768 / 0 | 237 / 128 / 878 / 0 | 237 / 128 / 734 / 0 |
| team | 254 / 111 / 870 / 0 | 254 / 111 / 770 / 0 | 351 / 155 / 738 / 0 | 581 / 248 / 878 / 0 | 581 / 248 / 857 / 0 |
| settings-long | 199 / 111 / 900 / 0 | 199 / 111 / 800 / 0 | 225 / 136 / 768 / 0 | 304 / 174 / 1195 / 0 | 304 / 174 / 1259 / 0 |
| settings-short | 199 / 111 / 900 / 0 | 199 / 111 / 800 / 0 | 242 / 136 / 768 / 0 | 304 / 174 / 878 / 0 | 304 / 174 / 734 / 0 |
| info | 111 / 111 / 870 / 0 | 111 / 111 / 770 / 0 | 111 / 111 / 738 / 0 | 165 / 165 / 878 / 0 | 165 / 165 / 941 / 0 |
| pinboard | 111 / 111 / 900 / 0 | 111 / 111 / 800 / 0 | 111 / 111 / 768 / 0 | 148 / 148 / 1512 / 0 | 148 / 148 / 1512 / 0 |
| todos | 111 / 111 / 900 / 0 | 111 / 111 / 800 / 0 | 111 / 111 / 768 / 0 | 165 / 165 / 1157 / 0 | 165 / 165 / 1280 / 0 |

**it, light** (only cells that differ from en)
| page | 1440x900 | 1280x800 | 1024x768 | 390x844 | 320x700 |
|---|---|---|---|---|---|
| dashboard-day | 140 / 119 / 1958 / 0 | = | = | 266 / 248 / 4442 / 0 | 304 / 287 / 4523 / 0 |
| dashboard-week | = | = | = | = | 304 / 287 / 4439 / 0 |
| dashboard-month | = | 140 / 119 / 1957 / 0 | = | = | 304 / 287 / 4439 / 0 |
| timesheet-month | = | 757 / 91 / 2182 / 0 | = | 1160 / 215 / 3098 / 1 | = |
| issues | = | = | 437 / 153 / 2512 / 0 | = | 700 / 228 / 5946 / 1 |
| issue-detail | 509 / 162 / 900 / 0 | = | 2360 / 215 / 768 / 3 | 2557 / 294 / 3602 / 3 | 2789 / 353 / 3834 / 3 |
| board | = | = | 225 / 153 / 768 / 0 | = | = |
| board-pinboard | = | = | 256 / 153 / 768 / 0 | = | = |
| notes | 289 / 111 / 900 / 0 | 289 / 111 / 800 / 0 | 328 / 149 / 768 / 0 | 319 / 196 / 878 / 0 | = |
| ideas | = | = | = | 263 / 207 / 878 / 0 | = |
| team | = | = | = | = | 581 / 248 / 878 / 0 |
| settings-long | = | = | = | = | 304 / 174 / 1228 / 0 |
| info / todos | = | = | = | todos 165/165/1172/0 | info 165/165/959/0, todos 165/165/1172/0 |

Derived from the measured values:
- **Timesheet week, 1280×800**: 43 px of the days grid shows in the first viewport (800 − 757).
- **Reports, 1024×768**: the Detail section starts after one full scroll.
- **Issue detail**: the Worklogs section needs 3 scrolls at 1024×768 and 2–3 on phones.
- **Dashboard on phones**: the page is 4,358–4,523 px tall, about 5.2 to 6.5 screens.

**Horizontal overflow (measured)**
- **Document**: no horizontal overflow in any capture.
- **Hidden overflow in `#main` (real)**:
  - Issues at 1024×768: `#main` can be scrolled 186 px (201 px in it). Its `overflow-x` is hidden, so the overflow only shows when focus or `scrollIntoView` moves it; a screenshot of it scrolled is in `why-issues-scrolled.png`.
  - The "Open and assigned to you" table at 1024 shows Key, Title, Status and Priority. Its other columns sit beyond the table's own horizontal scroller.
  - Board: `#main` hidden overflow of 33 / 193 / 449 px at 1440 / 1280 / 1024 (same in en and it). It comes from columns inside the board scroller, and the cards are reachable through it.
- **Not real**: `#main` is wider on phones (Dashboard week/month +414 to +655 px, Timesheet month +349 to +437 px, Team +314 to +384 px). The cause is the charts' accessible `table.sr-only` (772 px wide, invisible). No visible element goes past the viewport.
- **Sidebar**: on every desktop capture the running-timer note input ("What are you working on?") ends at x=301, past the sidebar's 264 px clip, so 37 px of it are cut.
- **Phones**: on Issues at 390 and 320 the quick-chip row goes past the viewport inside its own scroller (expected). Pinboard notes go past the viewport at 390 and 320, inside the canvas (expected for a canvas).
- **Dark captures**: no overflow or surface case appeared only in one theme. The dark results match light for every case above.

## Confirmed bugs (evidence)
| # | Bug | Evidence (measured or seen) | Code |
|---|---|---|---|
| C1 | **Dashboard Quick stats contradict the selected period.** In the week of 26 Oct–1 Nov, Summary says "42 h" while Quick stats say "Week 5 h 10 min" and "Month 5 h 10 min" (the current week and month). | Screenshot `dashboard-week__1280x800__en__light.png` | `src/pages/Dashboard.tsx` stats extras |
| C2 | **Sidebar draws favorites over the action rows below ~1000 px of height** when a timer runs. At 1280×800 the favorites overlap Dark theme, Screensaver and the timer chip, and Collapse sits at the bottom edge. At 1440×900 the third favorite is covered. Fine at 1440×1000. | `probe-sidebar-*.png`, `issue-detail__1280x800` capture | `src/components/AppLayout.tsx` favorites wrapper / action rows |
| C3 | **The sidebar timer note input is cut by 37 px** on every desktop page. | Input right 301 vs aside clip 264 (`why-overflow`) | `AppLayout.tsx` timer widget |
| C4 | **Keyboard-selected row hidden under the sticky header and filters** (Issues, `j`/`k`): 8 of 28 steps. The row top goes up to 283 px above the cover. | Probe H2 | `src/hooks/useListKeyboard.ts`, `IssueFilters.tsx` |
| C5 | **A period change shows wrong figures while loading.** Timesheet shows the new week's title with "Under goal" and totals left over from the old range, with no `aria-busy`. Dashboard marks only the timeline busy; the other sections keep the old figures under the new title. | Probe H1 (2.5 s delayed responses) | `Timesheet.tsx`, `Dashboard.tsx` `keepPreviousData` |
| C6 | **Phone inputs at 14 px** on every page measured, and 12.25 px on Pinboard. iOS Safari zooms in on focus below 16 px. | Probe H5, `inputs` in every phone capture | `src/components/ui/input.tsx`, `textarea.tsx` |
| C7 | **Issue detail below 1280: Worklogs come after every comment.** At 1024 Worklogs is at y 2414, after Comments at 2024. At 1280 and above they sit in the right column (y 514). | Probe H6 | `IssueBody.tsx` order classes |
| C8 | **Board at 1024 with the pinboard open: one column visible**, and the pinboard takes the rest. | Screenshot `board-pinboard__1024x768__en__light.png` | `Board.tsx` fixed `w-[420px]` |
| C9 | **ViewScope search flush with the panel edge.** The input sits 1 px from the panel edge, against 22 px for the h1 (19 px at 320). | Probe H8 | `ViewScope.tsx` |
| C10 | **QueryAssist in Italian**: the last chip "Loggate oggi" is out of view, and the scrollbar is hidden. In English the row fits. | Probe H12 | `QueryAssist.tsx` |
| C11 | **Team heat map "Under 50%" swatch is transparent.** The other steps are 100%, 55% and 30%. | Probe H22 (computed `rgba(0,0,0,0)`) | `components/team/model.ts` `bg-primary/12` |
| C12 | **`dashboard.stats` anchor on other pages.** It appears on Timesheet week and month, Reports, Issues and Issue detail, which pollutes FlowMap evidence. | DOM anchors per page | `QuickStatsCard.tsx` |
| C13 | **Shell nav rows Desk and Team carry no control id.** The other nav rows do (`shell.nav.*`). | DOM controls | `AppLayout.tsx` nav |
| C14 | **Studio issue-detail shot crashes.** `studio/screens/shoot.mjs` fakes live responses without the rich-text `doc`, so the page shows "Something went wrong". The app itself renders the issue with real responses. | Console capture `why-issue` | `studio/screens/shoot.mjs` (gitignored tool) |
| C15 | **Studio would recreate `inkledger_demo` on the production Postgres cluster** (`DATABASE_URL`, port 54329). | Code plus resolved URL | `studio/lib.mjs` (gitignored tool) |
| C16 | **A live read can change connection state.** A live read for a GitHub issue reached api.github.com with the demo token; the 401 marked the connection "no longer accepts the saved credentials", which shows a banner on every page. This was seen while diagnosing outside the matrix; the demo was reseeded before the run. | Screenshot during the probe | Provider error handling (by design for real tokens) |

## Rejected hypotheses
- **Plan bug 3, "header actions clipped at xl"**: rejected as clipping. No action goes past the header in en or it at 1280 or 1440 (rightmost edge 1244 of 1265). What happens instead: the header grows. Dashboard is 119 px at 1280 against 91 at 1440, and also 119 at 1440 in it. The Dashboard week title wraps to 2 lines at 1280, and Board actions drop below the title (header bottom 128).
- **Plan bug 14, "switching grouping to Client skeletons the trend and stats"**: not reproduced. No skeleton and no `aria-busy` in 6 frames with the client query delayed.
- **"Phone pages overflow sideways"**: rejected. The wide `#main` comes from the invisible `sr-only` chart tables (see overflow).

## Blocked or unreliable measurements
- **Desk with panes, the chat panel, and 6 panes at 1024**: the seed has no desk row, and adding issues to the desk is a persisted mutation. Measured only empty (desk, desk dark). The chat button is not shown on an empty desk.
- **Reports period-change flash** (H1.reports): inconclusive, because the range the probe switched to (September) is empty in the seed as well.
- **SelectionBar over the dock and toasts, the "{max}" palette toast, chat memory after logout**: all need persisted actions (desk add, sign out). Not measured. They remain code evidence only.
- **Date popover typing** (plan bug 15) and **dialogs with the phone keyboard** (plan bug 18): not measured. Headless Chromium has no on-screen keyboard. Code evidence only.

## Confirmed duplicate information (seen in captures)
- **Dashboard (week view)**: week total in Summary ("42 h") and in Quick stats (with another value, C1). Weekly goal in Summary ("goal 40 h") and in Quick stats ("Weekly goal 40 h"). The trend bars and the Summary describe the same week. The "My issues" columns repeat the Board's cards.
- **Timesheet (week, it)**:
  - Period name in the title ("Settimana 26 ottobre – 1 novembre") and as the stats card title ("Settimana").
  - Status as the "Stato: Aperta" row; projects in the legend and as the "Progetti 6" row.
  - The top issues in "Dettagli" are the same issues as the entries of the days grid below.
  - The stats card leaves about 400 px of empty column under it (1280×800).
- **Timesheet month**: Month appears as the stats card title and as the section title ("Month"); the calendar shows per-day hours.
- **Issue detail**: the shared stats card carries the dashboard anchor (C12).

## FlowMap anchors and controls today (DOM, 1280×800 en)
- **Dashboard**:
  - anchors: headerTimer, period, quickActions, customize, timeline, stats, summary, tasks, activity, recap;
  - controls: timer.pause/stop, period.day/week/month/previous/today/next, logTime, customize.open, timeline.gap/issueOpen (day view), tasks.openBoard/collapse/issueOpen.
- **Shell (every page)**:
  - anchors: search, notifications, navigation, pinboard, theme, screensaver, timer.active, quick-start, sync, account, sidebar;
  - controls: search.open, notifications.open, nav.home/board/pinboard/todos/ideas/issues/notes/timesheet/reports/settings/info, pinboard.toggle, theme.toggle, screensaver.open, timer.pause/stop/focus, quickStart.open, sync.start, account.open, sidebar.toggle;
  - **no** nav.desk or nav.team.
- **Mobile (in the DOM on every page)**:
  - anchors: todos, notifications, dock, home, board, timer.active, issues, more;
  - controls: todos.open, notifications.open, tabs.home/board/issues/more, timer.open.
- **Timesheet, Reports, Issues, Issue detail**: only the stray `dashboard.stats` anchor (C12), and no controls.
- **Board, Notes, Ideas, Desk, Team, Settings, Info, Pinboard, Todos**: nothing.

## Workflow entry points observed
- **Timer controls on the same running timer**: three places in the DOM on desktop pages. The Dashboard header has pause/stop/move/discard (4 buttons), the sidebar widget has pause/stop/focus, and the mobile tab bar has the timer button. "Start timer" stays visible in the sidebar while a timer runs.
- **Log time**: labelled "Log time" on Dashboard and "Log time today" / "Registra oggi" on Timesheet. Issue detail has "Start timer APP-214". The issue header holds 12 controls at 1280: back, favorite, watch, pin, TODO, triage, start, copy, open in Jira, open on desk, and more.
- **Send to desk**: "Open APP-214 on the desk" in the issue header (one of the 12 entry points found in code).
- **Dashboard header**: 13 controls at 1280: date, timer ×4, Day/Week/Month, previous/today/next, Log time, Customize.

## Wireframes (before = measured captures at 1280×800; target = proposal, to be measured again after B3)
Dashboard (week):
```
BEFORE                                         TARGET
[Title 2 lines][timer x4][D/W/M][<T>][Log][⚙]   [Title 1 line][D/W/M][<T>][Log][⋯]    (timer stays in sidebar)
[trend bars ............][Quick stats 340px]    [StatStrip: Total | Goal | Avg | Open | In progress]
[Summary 42 h + bars ][My issues 3 cols ...]    [trend bars, full width .........................]
[... activity, your week, 14 days below    ]    [Summary compact][My issues compact][Activity 5]
primary y 140, page 1957                        stats never contradict the period (C1)
```
Timesheet (week):
```
BEFORE                                         TARGET
[Title][W/M][<T>][⋯][Log today]                 [Title · Closed chip][W/M][<T>][⋯][Log]
[search flush left]                             [toolbar: scope · search (sticky)]
[Summary 42 h, legend, top 5][Week card 340]    [StatStrip: Total+goal | Entries | Under goal→ | Avg | Max]
  ~400px empty under the card                   [Days grid, 7 columns from xl .................]
[Days grid] ← y 757 (43 px visible)             [Breakdown (disclosure): project bar + top issues]
```
Reports:
```
BEFORE                                         TARGET
[Title][period][Export]                         [Title][period][group][Export]
[search flush left]                             [toolbar sticky]
[Trend ............][Period card 340]           [StatStrip: Total | Entries | Avg | Days | Issues | Projects]
[Detail] ← y 448 (1024: y 774, 1 scroll)        [Tabs: Period · Accuracy · Forecast]
[Accuracy][Forecast][Forecast]                  [Trend h-40][Detail grouped by Issue]
```
Issues:
```
BEFORE                                         TARGET
[Title + 3 actions]                             [Title + New][⋯ tracker search, clean up]
[Catalog][filters 2–3 rows][chips][toggles]     [toolbar: search · query · selects (sticky)][chips+toggles 1 row]
[pinned table][table min 720][aside stats 340]  [table full width, one line per row, timer icon]
1024: table cut, #main hidden overflow 186      no hidden overflow; selected row never under the bars
```
Issue detail (1024):
```
BEFORE                                         TARGET (lg+)
[Header 3 rows, 12 actions]                     [Title + meta line][Timer][Log][⋯]
[Fields][Time card][Description][TODO][Notes]   [Main: Description → Worklogs → Comments][Rail sticky: status,
[Linked][Mails][Comments][Worklogs] ← y 2322    time 4 rows, fields]  collapsibles for TODO/notes/mails/files
```
Board (1024, pinboard open):
```
BEFORE                                         TARGET
[Title + description][5 actions][search row]    [Title][scope][Filters ▾][view][pin][search]
[1 column visible][pinboard 420px]              [≥2 columns][pinboard ≤ 40% or inline from xl]
```
Sidebar (1280×800, timer running):
```
BEFORE                                         TARGET
[nav 13 rows][Favorites over Dark/Screensaver]  [nav][Favorites (collapses to header below ~900 px)]
[timer chip][note input cut 37 px][Start timer] [timer chip + note fit][Start timer hidden while running]
[Sync][Account][Collapse at the edge]           [Sync][Account ⋯ (theme, screensaver)][Collapse]
```
Notes, Ideas, Desk, Team, Settings: the targets are unchanged from the plan. The measured chrome is 111–150 px on desktop and 174–365 px on phones, and the primary content is on the first screen at every viewport. These pages are lower priority than the five above.

## Files expected to be touched later (not in B0)
- **BF0**: `src/components/AppLayout.tsx` (sidebar), `src/components/dashboard/QuickStatsCard.tsx` (anchor), `src/pages/Dashboard.tsx` (C1), `src/components/ui/input.tsx` and `textarea.tsx` (C6). Studio tools, gitignored: `studio/lib.mjs`, `studio/screens/shoot.mjs`.
- **B2A**:
  - `src/lib/workspace/collector.ts`, `instrumentation.ts`, `searchEvents.ts`;
  - `src/hooks/useHotkeys.ts`, `useListKeyboard.ts`;
  - `api/workspace/service.ts`, `src/lib/workspace/provider.tsx`;
  - `contracts/workspace/catalogV1.ts` (catalog version stays 1.0.0).
- **B1 and B3**: the pages and components listed in the plan.

## Frozen-file conflicts and other blockers
- **Day-hours**: landed (`006f898`, `3d58c4c`), so its files are no longer frozen.
- **Desk chat with code tools**: the agent worktree landed during B0 (`74cfcf8..a954351`, main is now `a954351`). It changed only `src/components/desk/DeskChat.tsx`, `src/lib/desk/*` and `src/lib/native.ts`, none of which B0 measured: the chat was blocked and not measured. No worktrees are left, so no files are frozen now.
- **Measured build**: `3d58c4c`. Measure the desk chat layout again once a seeded desk exists.
- **`pnpm parity:update`**: no longer blocked by open work, but still not run, since B0 changes no contracts.
- **Demo desk state**: blocked until a seeded desk exists. That needs a decision: extend the studio seed with a desk row, or accept the empty desk.

## Proposed BF0 scope (measurement blockers and severe regressions only)
1. **C12**: `QuickStatsCard` sets `data-workspace-anchor` only when given one. Without this fix the FlowMap baseline counts Timesheet, Reports, Issues and Issue detail as Dashboard stats.
2. **C1**: Dashboard Quick stats follow the selected period, or are labelled with their own period. The page contradicts itself in week and month views.
3. **C2 + C3**: the sidebar no longer overlaps or cuts below ~1000 px of height. It hides controls on common laptop heights.
4. **C13**: `shell.nav.desk` and `shell.nav.team` control ids. The baseline would miss navigation to two pages. This is additive and stays in catalog 1.0.0.
5. **C15 + C14** (gitignored studio, no app code): the default demo cluster must not be production, and the live fixture shape gets updated. This is so B0 can be rerun safely.

Left for BF (not BF0): C4, C5, C6, C7, C8, C9, C10, C11 and the rest of the plan's list. They are real, but they do not invalidate the audit or the telemetry.

## Verification
| Command | Scope | Result |
| --- | --- | --- |
| `pnpm lint && pnpm check && pnpm test && pnpm build && pnpm test:smoke` | day-hours tree (= main minus one doc) | green; unit 2971/2971 |
| `PROVIDERS_READ_ONLY=1 pnpm test:e2e` | same | 394/394 (the first try lost its log, a driver artifact; rerun green) |
| `pnpm build` | main `3d58c4c`, for the demo server | ok |
| `pnpm --dir studio seed` (STUDIO_DATABASE_URL = test cluster) | inkledger_demo on :54331 | ok (twice: a GitHub 401 seen while diagnosing was reset) |
| `node audit.mjs run` | 340 captures | 0 failed, 0 page errors, only `issues.markSeen` POST (blocked) |
| `node probes.mjs` | 22 probes | see confirmed and rejected above |
| Full suite | B0 adds no versioned code | not rerun (by rule) |

## Batches and progress
- [x] **B0** measured audit (above).
- [x] **BF0**:
  - C12: `QuickStatsCard` sets an anchor only when given one.
  - C1: the Dashboard's quick stats say "This week" / "This month".
  - C2 + C3: the sidebar.
    - The favourites area clips to its title.
    - The column scrolls when even the fixed rows do not fit.
    - The timer block is one track wide.
    - Focus sits beside the note.
  - C13: `shell.nav.desk` and `shell.nav.team`.
  - Studio (gitignored):
    - the default cluster is the test one (`E2E_DATABASE_URL`);
    - the live fixture has the rich-text `doc`;
    - the seed has a desk of three issues.
  - Regression e2e: `e2e/ui-density.test.mjs`. The sidebar test was shown to fail on the old code at three sizes.
- [x] **B2A**:
  - F5: `currentEffectiveRevision`; a tab is behind on any effective change; per-surface renderer fingerprint (D-66, D-67).
  - Collector: coalesced scans, exposure of tall blocks, `workspace:key` from hotkeys, the click spot on the visible part (D-68).
  - Ids: `mobile.timer.start` is a disclosure; `closeDay` and `pickDate` are marked; an opened issue is no longer counted as going to the Issues list.
  - Each change has a unit test that failed first.
- [x] **B2B**:
  - Surfaces `reports`, `timesheet`, `issues`, `board`, `desk`, `team`. They are observed as they are (D-64), and the catalog stays 1.0.0 (D-65).
  - `SURFACE_IDS` is the single list: type, validation and renderers come from it.
  - `ObservedPage` wraps the six routes.
  - Anchors and controls are on the pages, with no layout change.
  - The Studio lists the observed pages; the first card keeps the Tab stop.
  - Migration `0040_flow_events_time`.
  - The parity is re-baselined. Why: old clients ask only for their three scopes, so they never receive the new ids.
  - e2e: Reports' grouping and the `t` hotkey are stored as `reports` / keyboard events.
- [x] **B1**:
  - `StatStrip`, `PageToolbar`, `Tabs` + `TabPanel`, `Disclosure`, and `nextIndex` (roving, modifiers ignored, unit-tested).
  - Documented in design-system §6.1.
  - **Not mounted on any page**, so the baseline layout is unchanged.
- [ ] **Baseline**: skipped by the user's choice (3 Nov: "everything now, no stops"). B3/BW/B4 were done on the audit's measures; the heat maps from real use still apply to later layout proposals.
- [x] **B3** (all pages, no intermediate review, by the user's choice):
  - **Reports**: StatStrip (Total leads, Entries, Avg/day, Days worked, Issues, Projects, Parallel) → Tabs Period · Estimate accuracy · Forecast (tab in the URL, forecast only when available, accuracy says it ignores the filters). Default grouping Issue. ViewScope inside a PageToolbar. Long ranges draw bars side by side with month names (PeriodBars).
  - **Timesheet**: StatStrip (Total with goal meter, Under goal, Entries, Avg, Max day, Projects; "—" while stale), PeriodSummary in a "Breakdown" disclosure, month = MonthView only, week grid 2 → 4 (xl) → 7 (2xl) columns. Close week asks when days are under goal.
  - **Issues**: no aside; compact StatStrip (filters) above a single-column list; rows on one line; actions visible on touch; `/` focuses the search; QueryAssist wraps.
  - **Issue detail**: worklog before comments; header actions as icons (Watch, Pin, TODO) + ⋯ menu (triage, copy, open in tracker); star and edit run on after the title's last word; time card is a compact StatStrip with the progress meter.
  - **Dashboard**: the side column is a band above the timeline (timeline full width); stats StatStrip (This week leads with meter); "Last 14 days" removed. Recent activity is a full-width rail of tiles ("pick up again": key, title, status, hours as a thread along the edge, ▶), one row whatever the count, its order in the section header; a band in the composition (`DASHBOARD_BANDS`), so the Studio draws it the same. Summary and My issues are a bento row: one height, My issues fills it (as many cards as fit, fading towards the board).
  - **Board**: pinboard `min(30rem, 40%)`, its button icon-only below 2xl; ▶ on each card (`board.card.start`).
  - **Notes / Ideas / Settings / Team**: header `min-h` gone, ideas columns scroll inside themselves, save state in the title row, Team's KPIs are the only filter.
  - Shared: phone inputs at 16 px (`text-field`), breadcrumb hidden when it repeats the title, description one line on phones, dialog titles left-aligned clear of the close button, sticky dialog footer on phones, `interactive-widget=resizes-content`.
- [x] **BW**: `t` on an issue starts its timer; ▶ on the timeline's open hole starts from it (clamped inside the track); ▶ on board cards; Close week confirmation; date popovers commit on Enter/blur while typing (`DateJump`); the issue edit dialog asks before discarding changes and its textarea is capped.
- [x] **Sidebar** (after user review, 3 Nov):
  - Daily destinations are rows; the other entries are tiles: 3 columns open, 2 closed, same order, every entry inside the navigation block.
  - The foot is the Now card (every timer control on two lines, Start timer always), then the account, then the quick tiles with the toggle last. Closed, the ring opens a player with the same lines.
  - It never scrolls from 700 px, and the timer is isolated, so the sidebar does not redraw on every tick.
- [x] **B4**: `QuickStatsCard` deleted; catalog renderers → StatStrip, `dashboard.stats` `semanticRevision: 2` (catalog stays 1.0.0: the anchor id is kept); design-system rules on covers updated; PDF regenerated.
- Fixes reported during B3: the hole's Play cut at the start of the day; Bonsai over the live block's Pause/Stop (page controls drawn over a mod are `data-above-modules`, `hit.ts` leaves them to the page); theme colour back on the strips (faint sunset wash + data meters + lead figure in the primary colour).

- [x] **BF, the parts that keep the layout** (so the baseline stays valid). Each was shown failing first.
  - C4: the keyboard-selected row is brought out from under the sticky header and filters (`useListKeyboard`).
  - C5: while another period loads, Timesheet's summary and days and the Dashboard's summary are dimmed and `aria-busy` (`PanelSection busy`). No empty week and no under-goal count are made of the previous period's data.
  - C11: the Team heat map's "under 50%" step is `/15`, on the scale. A unit test checks every step's opacity against Tailwind's scale.

- [x] **Correctness and accessibility, no layout change:**
  - **Translated messages now get every value they name.** New `contracts/i18n/params.test.ts` checks every `t("key", { ... })` in `src/` and `api/` against its English placeholders. It found two literal placeholders on screen:
    - "added to the desk (2/{max})" from the palette;
    - "Link to {issue}" on the relink button of an issue's notes.
  - **A malformed remote link no longer blanks the issue page.** The new `hostOf()` is shared by `RemoteLinks` and `ExternalLink`, with unit tests.
  - **Recent activity says its real sort direction** (issue and status ascending). Its "Issue" header is translated. A unit test checks the directions, and the sort is in `activitySort.ts`.
  - **QueryAssist's field completions** are a plain group of buttons, not a fake listbox.
  - **Install**: the iOS note sits after the list, not inside the `<ol>`.
  - **Reports' Avg/day** says "—" when no day was worked, as Total does.
  - **Italian**: "Scarta timer", not "Annulla timer", beside the plain "Annulla".

Left for B3, because they change the layout and so belong after the baseline:
- C6 (phone inputs at 16 px);
- C7 (worklogs before comments below 1280);
- C8 (the pinboard's width at 1024);
- C9 (ViewScope inset);
- C10 (QueryAssist wrapping);
- the plan's lower items.

## Verification (BF0 → B1)
| Command | Scope | Result |
| --- | --- | --- |
| `pnpm lint`, `pnpm check` | main + BF0/B2/B1 | clean |
| `pnpm test` | same | all pass except `api/modules/modules.test.ts > no private key is ever committed`. That failure came from `src/lib/desk/browserCode.test.ts` (`a954351`), whose fixture was shaped like a private key's marker. It has since been fixed on main by the Desk work, and the suite is green again (see below). |
| `pnpm build`, `pnpm test:smoke` | same | ok |
| `PROVIDERS_READ_ONLY=1 pnpm test:e2e` (BF0) | 405 tests | 404 pass. The one failure (`mods-real` Bonsai film focus) passes 2/2 alone: a flaky test under concurrency. |
| `node --test e2e/ui-density.test.mjs` | 7 tests | pass |
| Full suite, final (3 Nov), everything above | lint, check, build, smoke | clean |
| `pnpm test` (final) | 3069 tests | all pass |
| `PROVIDERS_READ_ONLY=1 pnpm test:e2e` (final) | 412 tests | **412 pass** |
| Clean HEAD (`ac585d0`) in a throwaway worktree | full e2e, for comparison | 403/403 |

Flakiness found and fixed, with evidence:
- **Cause.** A flush beacon sent while a page navigates away is sometimes cut off in headless Chromium (`net::ERR_ABORTED`, seen on the requests).
- **Effect.** `e2e/ui-density` ("observed pages") and `workspace-flows` #14 failed now and then in full runs.
- **Fix.** Both now leave the page through its `pagehide`, with the page alive. The intent of each test is unchanged. A test that also ran into the tests' adjustments: `dashboard-day` (the timeline's own `aria-busy`) and `search-memory` (field completions are buttons now).

## After B3–B4: measured again (3 Nov, same pipeline)
Same driver, demo database on the test cluster, en, light, scroll 0. Values in px: y of the primary block, then the page's full height. The ✓ marks a better value.

| Page | 1280×800 top | 1280×800 height | 1024×768 top | 390×844 top |
| --- | --- | --- | --- | --- |
| Timesheet week | 757 → 210 ✓ | 4114 → 2606 ✓ | 1055 → 269 ✓ | 1181 → 441 ✓ |
| Timesheet month | 757 → 210 ✓ | 2182 → 770 ✓ | 1055 → 269 ✓ | 1142 → 441 ✓ |
| Issue detail | 509 → 403 ✓ | 800 → 800 | 2322 → 692 ✓ | 2517 → 843 ✓ |
| Issues | 395 → 380 ✓ | 2195 → 2129 ✓ | 407 → 460 | 670 → 810 |
| Dashboard day | 140 → 232 | 1957 → 1642 ✓ | 195 → 276 | 266 → 464 |
| Reports | 448 → 547 | 1154 → 1906 | 774 → 609 ✓ | 836 → 765 ✓ |
| Ideas | 170 → 121 ✓ | 800 → 800 | 212 → 163 ✓ | 245 → 181 ✓ |
| Board | 200 → 200 | 800 → 800 | 263 → 225 ✓ | 353 → 316 ✓ |

Reading:
- **Dashboard.** The timeline starts lower because the figures are a band above it (it now has the whole width), and the page is 300–1080 px shorter.
- **Figures on phones.** Three to a row, two short rows for five. Primary top at 390×844: Dashboard 464 → 380, Timesheet 441 → 357, Reports 765 → 681.
- **Reports.** The table shows its first 10 rows, then "Show all" (the CSV keeps every row). The Detail starts lower at 1280, under the tabs and the trend.
- **Overflow.** Unchanged: the Board's lanes and the Dashboard's tile rail are declared scrollers.
- **Sidebar.** Never scrolls at 700–1000 px high, open and closed, en and it.

## Spatial system and non-list forms (3 Nov, after the user's review)
Rules in `docs/design-system.md` §7.1 (regions `@m/@l/@xl`, three page layouts, Collection, Toolbar, budgets enforced by `e2e/space-budget.test.mjs`), shadows as paint only (§5). One commit each, `e9d0ded` → HEAD, not pushed.

- [x] Spatial primitives, accessibility measured (focus clear of bars, 24/44 px targets, forced colours).
- [x] Timesheet week as an issues × days grid; month as one calendar, a phone too.
- [x] Issues: one-line filters, preview beside the list at `@xl`; phone j/k selection shown and kept on screen.
- [x] Issue: one datum once, Your work in tabs with counts; worklogs by person and bounded; comments latest 3; attachments by width; other fields as a sheet.
- [x] Dashboard bento by region; Activity as a bounded Collection; Summary as project bands (`semanticRevision` 2); the day's plans folded.
- [x] Board: cards in no column folded by status. Ideas list as a bounded grid per state.
- [x] Notifications stacked per issue (`notifications.dismissMany`), filtered by kind.
- [x] Day review gaps on a strip; idle dialog as a list of choices; dialog/sheet close at 24 px.
- [x] Reports Days as an issues × days matrix up to 31 days (cards past it).
- [x] Shadows never move layout (constant `--surface-room`, clip margins; three-state e2e).
- [x] **Buckets drag board**: chips dragged into columns, a menu each for the keyboard; one column per status (user's decision, 3 Nov), the server and the Board aligned.
- Dropped: TODO Upcoming as 7 day columns, Issues grouped by status (reasons in the plan).

| Verification | Scope | Result |
| --- | --- | --- |
| `pnpm lint && pnpm check` | all | pass |
| `pnpm test` | unit | 3094 pass |
| full `pnpm test:e2e`, isolated worktree at `9353eae` | e2e | 427/430; the 3 mail-copies failures fixed in `3839adf` (test opened no tab) |
| targeted e2e after each later commit | touched files and neighbours | pass |
| full `pnpm test:e2e`, isolated worktree at `7cef070` | e2e | 430/432 (5 skipped); the 2 failures (desk-snap Move to, flowmap Dashboard clicks) ran beside the audit and pass alone |
| `e4f379d` (after that run) | dashboard-day, space-budget, ui-density, touch-targets, renders, flowmap | pass |
| full `pnpm test:e2e`, clean worktree at `704d670`, nothing else running | e2e | 432/433 (5 skipped); the one failure was the install test's route still fetching a font at close (`route.fetch: Request context disposed`), fixed in `f768e8b` and passing 3/3 |
| final screenshots, demo data, Italian, dark | Dashboard 1280/390, Reports Days, Timesheet week, issue on a phone, Ideas | as intended (`studio/out/ui-density/shots/section-final-*`) |

### Measured again after the non-list forms (3 Nov evening, same driver, full run: en + it, light, dark where it differs)
261 captures, 0 failed; `studio/.session` backed up and restored. Page full height in px, en light, before (morning run) → after.

| Page | 1280×800 | 390×844 |
| --- | --- | --- |
| Timesheet week | 2606 → 1308 ✓ | 6050 → 909 ✓ |
| Timesheet month | 770 → 770 | 2189 → 878 ✓ |
| Reports | 1906 → 1250 ✓ | 2776 → 1706 ✓ |
| Issue detail | 800 → 800 | 3459 → 2736 ✓ |
| Dashboard day | 1642 → 1498 ✓ | 3217 → 3886 ✗ → fixed in `e4f379d` (My issues stacked showed every card: 777 → 512 px for the block) |
| Issues | 2129 → 2094 ✓ | 5390 → 5051 ✓ |
| Desk | 800 → 800 | 2924 → 2265 ✓ |
| Board, Notes, Ideas, Team, Settings, TODO | unchanged (they fit the screen) | unchanged or ✓ |

- **Overflow:** the English cases are the same as before: the Board's lanes and the Team table are declared scrollers, and the timeline's weekday labels are clipped by 3–4 px at 1024. The Italian ones have no baseline, since the morning run was English only. They are the same kinds.
- **Dark shots:** the driver re-shoots dark only at 1280/390 en, plus the overflow cases. An older dark Italian file (`reports__1280x800__it__dark.png`, 2 Nov) is stale, not a regression; the same page in Italian, light, today is correct.

## Next action
- **Done** (3 Nov): B0 → B4, plus the sidebar redesign. Commits `92d09e1`, `5fe45c5`, `7a40fea`, `e48acb5`; not pushed.
- **Done after:** the denser figures on phones, and Reports' table bounded.
- **Verification (final):**
  - lint, check and unit (3081/3081) pass;
  - full e2e 413/415. Both failures pass alone (29/29): `dist/` was rebuilt by another process during the run.
- **Open:** FlowMap on, on dev :3000, so that real heat maps drive the next layout proposals.
