# Changelog

All notable changes. The version is `package.json`'s; the native apps take it from there.

## Unreleased

### Fixed (time is never lost or counted twice)
- A write whose answer timed out, came back malformed, or was followed by a fault on this server
  is kept and queued, then reconciled without a duplicate. Only a tracker's own refusal drops it.
- A tracker's edit that landed with its answer lost is recognized on replay instead of failing.
- Tempo (no idempotency key): a create sent again after a lost answer is matched to the entry
  already there, never logged twice.
- Queued edits being sent by another server process are never dropped by a new edit, a delete or a
  discard (they answer "try again").
- Time sinks' pending entries and every time write are serialized across server processes (an
  overlap or a closed week holds with two processes on one database).
- Sync: a lost lease records nothing; long passes keep their lease alive; the first Jira import
  reads every issue (no 5000 cap); "Sync" says which trackers failed and fails when all did.
- Restore: maintenance mode while it runs; a failure after the backup went in brings the safety
  copy back, or keeps the server closed to writes.

### Security
- No public default admin password in production; sessions rotate on password change; bounded
  login rate limits; no tokens in request logs; backups readable by their owner only.
- In production, self-hosted trackers are an admin's to connect unless `REMOTE_ALLOWED_HOSTS`
  lists them. Store requests follow no redirect and are size-capped. The extra module key needs
  `MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION=1` in production.
- Native: Tailscale Serve publishes only the local server the window shows.
- Dependencies upgraded past known advisories (Zod, Hono, react-router, Vite, Vitest and
  transitive ones).

### Interface
- No write on data that couldn't be read: Day Review, Log time, issue editors and lists say
  what failed, with Retry.
- Accessibility: no nested controls in the sidebar, better contrast, dialogs that fit short
  screens, cut-off links out of the tab order, keyboard selection kept in view.

### Performance
- Responses compressed (precompressed assets, gzip API); the first bundle carries English
  only (848 KiB instead of 945); the sidebar loads favorites, not the whole catalogue.

### Build and release
- `pnpm docker:update` (backup, build, swap, health, rollback including the database),
  `pnpm docker:from-dev`, `pnpm dist` (unsigned macOS and Android builds with checksums),
  `pnpm perf` (durations and resources).
- CI: e2e, native and Docker-run jobs, dependency audit, actions pinned, Dependabot for every
  ecosystem. Base images pinned by digest.
