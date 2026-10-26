# Performance

The first measured run of the production builds, and where efficiency can be gained.
[measuring.md](measuring.md#durations-and-resources) says how the numbers are taken
(`pnpm perf`). Commit `b453333`, Apple M2 Pro, Node 24, Chromium headless, Colima. Milliseconds
are this machine's: compare them only with later runs on the same one.

## The builds

| Build | Command | Time | Size |
|---|---|---:|---:|
| Server image `inkledger:<sha>` | `pnpm docker:update` | 41 s (cached deps) | 85 MiB compressed, 391 MB on disk |
| macOS app (arm64, unsigned) | `pnpm dist --mac` | 247 s (clean) | .dmg 4.7 MiB, .app 7.8 MiB |
| Android APK (arm64) | `pnpm dist --android` | 221 s | 8.9 MiB |

`pnpm docker:update`: the swap took 2.8 s from `compose up` to a healthy container.

## Server

Seed: 500 issues, 1200 worklogs (a year of one person's work).

| Measure | Value |
|---|---:|
| Boot to healthy (migrated database), p50 | 0.9 s |
| RSS at that moment | 276 MiB |
| RSS idle (after seeding) / after the page and API load | 58 / 125 MiB |
| CPU idle, sync off | 0.1% |
| Docker idle: app / database | 0% · 62 MiB / 0.7% · 46 MiB |

tRPC calls the pages make, replayed one at a time (p50 / p95) and ten at once (p95):

| Call (batch) | p50 ms | p95 ms | p95 ×10 | KiB | KiB gzip |
|---|---:|---:|---:|---:|---:|
| `settings.get, timers.list, … issues.all …` (every page) | 28.7 | 38 | 297 | 210.3 | 7.3 |
| `queries.list, issues.list ×2` (Issues) | 22.9 | 43 | 139 | 33.1 | 1.7 |
| `issues.all, issues.allSize, pinboard.boards, buckets.statuses` (Board) | 18.7 | 25 | 189 | 207 | 5.9 |
| `stats.dashboard, worklogs.list ×2, …` (Dashboard) | 15 | 25 | 91 | 26.6 | 3 |
| `reports.generate ×3` | 13.5 | 34 | 47 | 21.4 | 1.9 |
| `auth.me` | 6.7 | 9 | 10 | 0.2 | 0.2 |

## Pages (cold cache, then warm)

| Route | FCP ms | LCP ms | KiB moved | Requests | Script ms | Heap MiB | DOM nodes | Warm KiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `/` | 132–300 | 524–900 | 1597 | 39 | 117–183 | 9.6 | 1.9k | 241 |
| `/issues` | 116 | 512 | 1614 | 42 | 179 | 14.5 | 4.2k | 272 |
| `/issues/PERF-1` | 136 | 672 | 1790 | 45 | 155 | 12.4 | 0.9k | 427 |
| `/timesheet` | 164 | 544 | 1554 | 37 | 120 | 9.8 | 2.0k | 225 |
| `/board` | 128 | 524 | 1752 | 40 | 230 | 27.2 | **10.9k** | 423 |
| `/reports` | 108 | 356 | 1555 | 37 | 109 | 8.4 | 1.7k | 236 |
| `/settings` | 108 | 260 | 1646 | 40 | 105 | 9.7 | 1.3k | 216 |

The first route of a run includes the browser's warm-up (two runs: 132 and 300 ms FCP). The
only long tasks: Board 128–135 ms, one per load.

## Native app (macOS, idle on its server picker)

| Process | RSS MiB | CPU idle |
|---|---:|---:|
| inkledger (Rust, AppKit, tray) | 106 | 1.6% |
| WebKit WebContent | 32 | 0.7% |
| WebKit GPU | 25 | 0.3% |
| WebKit Networking | 10 | 0.1% |
| **Total** | **172** | **2.6%** |

First web process up 0.5–0.9 s after launch. On a server's pages the WebContent process grows
like a browser tab (see Pages: 8–28 MiB of JS heap alone).

## After the fixes (Oct 25, same machine and seed)

| Route | KiB moved cold (before → after) | Warm KiB (before → after) | LCP ms (before → after) |
|---|---:|---:|---:|
| `/` | 1597 → 450 | 241 → 15 | 524 → 408 |
| `/issues` | 1614 → 447 | 272 → 16 | 512 → 304 |
| `/issues/PERF-1` | 1790 → 458 | 427 → 21 | 672 → 304 |
| `/timesheet` | 1554 → 442 | 225 → 13 | 544 → 204 |
| `/board` | 1752 → 441 | 423 → 13 | 524 → 368 |
| `/reports` | 1555 → 439 | 236 → 14 | 356 → 288 |
| `/settings` | 1646 → 481 | 216 → 12 | 260 → 216 |

Server image 86 → 68.5 MiB; entry chunk 945 → 848.7 KiB.

## Where to improve

Ranked by gain for the cost. Each claim has its evidence in the numbers above.

1. **Compress responses: fixed.** Nothing used to be compressed.
   - **Static:** `scripts/precompress.mjs` writes `.br` and `.gz` beside every text asset at
     build (40 files, 1631 → 427 KiB brotli). `serveStatic` sends them by `Accept-Encoding`,
     still `immutable`; `pnpm test:smoke` checks it.
   - **API:** `hono/compress` on `/api/trpc/*` (gzip). The SSE stream `/api/events` is never
     compressed (`api/compression.test.ts`).
   - **Expected:** the batch on every page ~7 KiB instead of 210 KiB, a cold page ~0.5 MB
     instead of ~1.6 MB. Measure again with `pnpm perf`.
2. **Entry chunk over its budget: fixed.** It was 945 KiB / 300.5 gzip against 925 / 295
   (`pnpm test:smoke` failed on `main`).
   - **Cause:** both languages' texts (234 KB unminified) were in the entry.
   - **Fix:** the page's build takes `contracts/i18n/client.ts`: English in the bundle, Italian
     fetched when chosen (before the first paint), the others while idle. The server keeps
     every language.
   - **Now:** 847.7 KiB / 268.8 gzip. The budget is unchanged.
3. **`issues.all` on every page: fixed.** The sidebar's favorites and its unread counter loaded
   the whole catalogue (207 KiB for 500 issues).
   - **Fix:** `issues.favorites` (the favorites alone) and `issues.unreadCount` (one number).
   - **Now:** only the pages that pick issues (Dashboard, Issues, Timesheet, Board) ask for it,
     compressed to ~6 KiB.
4. **Board renders every card.** 10.9k DOM nodes and 27 MiB of heap for 500 issues, the only
   long task measured (130 ms).
   - **How:** virtualize each column, or render the first N cards per column plus "show more".
     This also cuts the WebContent memory of the native app.
5. **Server image carried ~70 MB it never ran: fixed.** PGlite, TypeScript and better-sqlite3
   stayed in `/app/node_modules` as drizzle-orm's optional peers.
   - **Fix:** the Dockerfile removes them after the prune; better-sqlite3 is a dev dependency
     now (only `scripts/sqlite-to-postgres.mjs` uses it).
   - **Now:** node_modules 110 → 40 MB, image 86 → 68.5 MiB compressed. The container was booted
     on Postgres and answered health and the page.
6. **Docker build context.** `.dockerignore` did not exclude `src-tauri` (2.4 GB of Rust
   `target/`), `studio`, `e2e`. **Fixed in this change**: the context is now the server's
   sources only.
7. **Native shell idle cost.** 106 MiB and 1.6% CPU for the Rust process on a static page.
   - `sample` shows JavaScriptCore's allocator scavenger and a running `CVDisplayLink`. The
     tokio runtime starts one worker per core (10 threads here), plus the idle and tray threads.
   - **How:** a `current_thread` or 2-worker tokio runtime. Check whether the display link stays
     on with no animation on screen.
   - **Gain:** small per user. It counts because the app lives in the menu bar all day.
8. **Server memory at boot.** 276 MiB RSS at the first healthy answer, against 58 MiB steady.
   - Transient: the heap is not collected yet after migrations and module load.
   - Only matters on a small VPS. **How:** `--max-semi-space-size`, or `NODE_OPTIONS` in the
     Dockerfile, once measured there.

**Not worth it now:**
- The API latency (5–30 ms single, local Postgres).
- Idle server CPU (0.1%).
- The native bundle sizes (4.7–8.9 MiB, Tauri's floor).

## Lighthouse baseline (2026-10-26, 40e5e3a, Lighthouse 13.5.0)

Method in measuring.md § Lighthouse. Lowest of three runs per scenario, modules off.
Categories: Performance / Accessibility / Best Practices / SEO.

| Scenario group | Desktop | Mobile |
| --- | --- | --- |
| Public (login, install, invite) | 99 / 100 / 100 / 100 | 85–87 / 100 / 100 / 100 |
| Signed-in pages (dashboard, issues, issue, board, settings sections…) | 98–99 / 95–97 / 96–100 / 100 | 80–85 / 98–100 / 96–100 / 100 |
| /info | 99 / 89 / 100 / 100 | 85 / 92 / 100 / 100 |

186 runs, 184 below 100 somewhere. Causes found and fixed after the baseline:

- **Accessibility:** the brand link's name did not start with its visible text (2.5.3); the
  Favorites header and its "All" link were under 24 px; /info's address list broke `<dl>` rules;
  the TODO "Plan today" heading skipped a level.
- **Best Practices:** projects without an icon answered 404 (console errors) — now 204; the large
  script had no source map — now published (the source is public).

Re-measured after the fixes (dashboard, login): Accessibility, Best Practices and SEO 100 on
desktop and mobile; Performance 99 desktop, 79–87 mobile (the spread is the local CPU: Lighthouse's
simulation scales observed task times).

**What mobile Performance 100 needs.** Under the simulated mobile profile (slow 4G, 4× CPU) the
page paints only after the entry script (~230 KB brotli: react-dom alone ~60 KB) runs and the first
tRPC batch answers: FCP ≈ 2.1 s, LCP ≈ 4.3 s on the dashboard. A 100 needs FCP ≈ 1 s and LCP ≈ 1.3 s,
which a client-rendered app cannot reach by trimming: it needs the first screen rendered on the
server (with its data) and hydrated after. Trimming done so far (dialog hosts lazy-loaded) does not
move the score beyond the run-to-run spread. This is an architecture decision, not a tuning step.

### Final matrix (2026-10-26, 8bd14a7)

All 31 scenarios × desktop/mobile × 3 runs (186 runs, modules off): **Accessibility, Best Practices
and SEO 100 in every run.** Performance: desktop 98–99, mobile 77–92. Further fixes after the
baseline: zod runs jitless in the page (its eval probe broke the CSP on Settings), 24 px day-chart
targets, hole rows named in words. Mobile Performance 100 was left out by decision (it needs server
rendering, see above); the harness runs each Lighthouse in its own process and browser.

### Desktop load order (after the final matrix)

Desktop Performance was held back by LCP only (FCP ≈ 0.44 s, LCP ≈ 0.95–1.09 s). Two changes:
on-demand parts are prefetched 1.5 s after the page's load (they competed with the page's own
chunk), and the requested page's chunk starts with the session check instead of after it.
Measured on login, dashboard, issue and a Settings section (2 runs each): login 100; the signed-in
pages 99 (LCP ≈ 0.88–0.98 s, FCP ≈ 0.53 s). 100 there needs LCP ≈ 0.75 s, i.e. the page's data
before its script (server rendering or a data preload): the same boundary as mobile, left out.

### SSR: login and dashboard day

`api/ssr.ts` renders only `/login` and the current Dashboard day; other periods and every other
route keep the SPA. Per-request tRPC helpers populate React Query's dehydrated state, with no
loopback HTTP or shared query client. The client hydrates that state; the native shell and
local-only layouts use a client render instead. HTML is `private, no-store`, its CSP hashes the
final inline scripts, and the service worker precaches only the anonymous `offline.html`.
The dehydrated script is removed from the DOM as soon as it is read. Device-scoped timer and
notification queries stay client-side; locale and initial clock are request-scoped. Hydration
runs only when the local day/time zone and local-only layout match, otherwise the client renders.
The session is revalidated before the HTML is sent, so a logout during rendering cannot restore it.

The authenticated document reissues the existing session cookie with its remaining lifetime:
Lighthouse supplies the cookie only for the navigation, so without it the later API calls failed
and the run measured a redirect to login. Before hardening, mobile Dashboard scored 90 with
LCP ≈ 2.85 s and TBT ≈ 20 ms, against 79–81 Performance and LCP ≈ 4.2–4.4 s before. After the
security fixes, its three final runs scored 88, 89 and 95 (the other categories stayed 100);
login scored 92 in all three (`perf/lighthouse/2026-10-26-12-50-26ab84a/summary.json`).

Inlining the whole compiled CSS into SSR HTML was measured and reverted: the larger document made
Performance fall to 80. SSR does not address Board/Issues DOM and hydration cost; their
virtualization remains separate.

The full matrix on this build (186 runs, `perf/lighthouse/2026-10-26-12-51-26ab84a/summary.json`)
kept Accessibility, Best Practices and SEO at 100 everywhere. Performance was 99–100 desktop and
81–97 mobile; Dashboard scored 100 desktop and 88–90 mobile, login 92–97 mobile. All 217 E2E and
2221 unit tests passed.

To measure the optimized build against development data, run `pnpm preview` and point Lighthouse
at `http://127.0.0.1:4173`. This serves the same built assets and SSR as production but keeps the
development environment, login, APIs and database. `PORT=4173 pnpm dev:build` is the explicit
equivalent; port 3000 belongs to Vite/HMR. The normal `pnpm lighthouse` remains the reproducible
matrix on its seeded, temporary database.
