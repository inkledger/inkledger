# Contributing

Thanks for helping. Bug reports, fixes and improvements are welcome; for a larger change, open an
issue first so we can agree on the approach.

## Setup

Requirements: Node 24, pnpm (the version in `package.json`), Docker (for Postgres), and for the
native shell Rust (`rustup`) plus Xcode / Android Studio.

```sh
pnpm install
cp .env.example .env          # set DATABASE_URL and SESSION_SECRET
docker compose up -d db       # Postgres on 127.0.0.1:54329
pnpm dev                      # http://localhost:3000
```

## Tests

| Command | What it needs |
|---|---|
| `pnpm lint && pnpm check` | nothing else |
| `pnpm test` | nothing else (Postgres via PGlite, no network) |
| `pnpm build && pnpm test:smoke` | nothing else |
| `PROVIDERS_READ_ONLY=1 pnpm test:e2e` | Postgres (`DATABASE_URL` in `.env`, or `E2E_DATABASE_URL`) and Chromium (`pnpm exec playwright-core install chromium-headless-shell`) |
| `cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked` | in `src-tauri/` |

Test servers must never reach a real tracker: always run them with `PROVIDERS_READ_ONLY=1`. Each
end-to-end test makes and drops its own database.

## Conventions

- TypeScript strict, no `any`; English in code, comments and docs.
- User-visible text goes in `contracts/i18n/en` and `contracts/i18n/it` (same keys in both).
- A bug fix comes with a test that fails without it; an interaction bug, with one in `e2e/`.
- Every write of time goes through `api/sync/timeWrites.ts`; new providers follow the contract in
  `api/providers/types.ts` and come with an HTTP simulator.
- Schema changes: edit `db/schema.ts`, run `pnpm db:generate`, give the migration a meaningful name.
- Commits: `type(scope): description` (Conventional Commits), 50 characters at most.

## Code of conduct

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
Report unacceptable behaviour privately to the maintainers (see SECURITY.md for the private channel).
