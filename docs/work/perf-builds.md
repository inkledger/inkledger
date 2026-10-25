# Status: production builds and performance

## Goal and done criteria
Production builds for Docker and Tauri, a script that updates the container, a script that
makes the apps to hand out, a measurement of the builds, and where to gain efficiency.

## Constraints and out of scope
- The old jtt stack (container, image, database) is never touched. Only the inkledger stack
  (deploy/staging.yml, :47824, read-only towards trackers).
- No optimizations here: performance.md proposes them.
- Unsigned native builds (no Apple Developer account).

## Decisions
- deploy/staging.yml versions the stack that ran from a temporary file. The image is built by
  the script and tagged `<sha>` + `latest`, with `prev` kept for the rollback.
- `pnpm dist` reuses native-publish for Android, so the APK also reaches the container.
- Perf reuses the e2e harness, so there is no second way to boot and seed a server.

## Batches
- [x] docker:update (backup, build, swap, health, rollback): run on staging, jtt unchanged
- [x] dist: .dmg/.app.zip/.apk + SHA256SUMS in release/0.1.0
- [x] perf server/page/docker/app + measuring.md section
- [x] performance.md: numbers and ranked improvements

- [x] docker:from-dev: dev's database and mods moved to the stack (instance key not copied).
  `CREDENTIALS_KEY_OLD` in `.env.inkledger` now opens dev's credentials: dev has no
  CREDENTIALS_KEY and seals with sha256 of its SESSION_SECRET.

## Checks
| Command | Scope | Result |
|---|---|---|
| `pnpm docker:update` | staging :47824 | healthy in 2.8 s; jtt image/start time unchanged |
| `pnpm dist` | mac + android | ok; dmg verified (hdiutil); APK sha matches the container |
| `pnpm perf server` ×2, `docker`, `app` ×2 | local | complete; page timings within ~15% |
| `pnpm docker:from-dev --yes` | staging :47824 | 1 user, 3 connections, 157 worklogs, 1787 issues, 6 mods; 3 secrets sealed again; GitHub 401 as in dev |
| `pnpm test:smoke` | dist | **fails already on main**: entry chunk 945 KiB > 925 budget (performance.md #2) |

## Blocks and next step
Next: pick improvements from performance.md (compression first), each measured with
`pnpm perf` before and after.
