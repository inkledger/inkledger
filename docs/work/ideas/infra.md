# Spec: services in containers, a clean machine

Status: B5.1, B5.3, B5.4 done 2026-10-30 (B5.4's CI run after the push). Open questions are asked when their batch is reached (README, R-0.12).


## Verified facts
- `docker-compose.yml` has two services, `db` (54329) and `inkledger`, with **no profiles**.
- `deploy/staging.yml` is the stack that CI deploys (54330 and 47824).
- Prod is still the `jtt` stack, which must not be touched.
- **The dev database `inkledger_dev` lives in the `jtt-db` container**, so dev depends on the prod container (`scripts/docker-from-dev.mjs`).

## Requirements
- **R-5.1** A separate dev compose, `deploy/dev.yml`, project name `inkledger-dev`:
  - `db`: `postgres:17-alpine` pinned by digest, `127.0.0.1:54331`, volume `inkledger-dev-pgdata`, healthcheck `pg_isready`;
  - profile `ai`: `ollama/ollama:<pinned tag>`, `127.0.0.1:11434`, volume `ollama-models`, `OLLAMA_KEEP_ALIVE=5m`, `mem_limit` and `cpus` (Q3), healthcheck `ollama list`;
  - profile `ml`: build `ml/forecast`, `127.0.0.1:8601`, volume `ml-models`, `mem_limit 1g`, healthcheck `/health`;
  - profile `archive`: documented but commented out (Open Archiver + Meilisearch + Valkey), for B1 option (b).
- **R-5.2** Scripts:
  - `dev:db` → `docker compose -f deploy/dev.yml up -d db`;
  - `dev:services` → `… --profile ai --profile ml up -d`;
  - `dev:services:down` → `… down` (**without** `-v`).
- **R-5.3** `.env.example` gains `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_ALLOW_PUBLIC`, `FORECAST_URL`, `FORECAST_MODEL`, `OTS_EXPLORER`, `MAIL_COPIES` and `MAIL_COPY_MAX_MB`, each with a one-line comment. `api/lib/env.ts` reads them in the style already used there (`weather`, `storeUrl`).
- **R-5.4** Moving the data:
  - `pg_dump -Fc inkledger_dev` from `jtt-db`, **read-only**;
  - `pg_restore` into the new db;
  - update `DATABASE_URL` in `.env`.
  - **Only after Q1.** `jtt-db` and its volumes MUST NOT be changed.
- **R-5.5** CI: no real model. The `docker` job also builds `ml/forecast` with `FORECAST_FAKE=1` and checks `/health`.
- **R-5.6** `CONTRIBUTING.md` and `docs/dev/` explain:
  - Ollama in Docker on a Mac runs on the CPU only (no Metal);
  - the recommended setup is native Ollama, or a machine on the LAN, through `OLLAMA_URL`.
- **R-5.7** Nothing goes into `deploy/staging.yml` or the `jtt` stack until Q2.

## Decisions
- **D-5.1 (B5.1, from the answers of 2026-10-30)** 54331 is the e2e tests' Postgres, not a dev database: dev logs on `jtt` (Q1). `deploy/dev.yml` (project `inkledger-dev`) has `test-db` (container `inkledger-test-db`, postgres:17-alpine pinned by the digest already on this machine, 127.0.0.1:54331, data in tmpfs: empty at every start). Scripts `pnpm test:db` (up, waits healthy) and `pnpm dev:down` (down, no `-v`: nothing to lose anyway). The harness takes `E2E_DATABASE_URL` from the environment or `.env`, else `DATABASE_URL` as before. The YAML is checked as Docker reads it (`docker compose config --format json`, `api/deployDev.test.ts`), skipped only where docker is missing (user's choice: no YAML dependency).
- **D-5.2 (B5.3)** The `ai` profile pins `ollama/ollama:0.34.4` (the version of the native Ollama on this Mac, published 2026-09-24) by digest; container `inkledger-ollama`, 127.0.0.1:11434, volume `ollama-models`, 8 GB / 4 CPU (Q3). Scripts `pnpm dev:services` (profile ai up) and `pnpm dev:down` (all down, no `-v`). Variables read by `serviceEnv` in `api/lib/env.ts` (pure, tested): unset URLs mean the feature isn't offered; an unusable URL counts as unset; `MAIL_COPIES` on unless "off" (each user still opts in); `.env.example` states Timestral's revenue cap. The Ollama how-to (native vs container, no Metal in Docker) is in `docs/dev/services.md`, linked from CONTRIBUTING.md.
- **D-5.3 (B5.4)** Profile `ml`: service `forecast` built from `ml/forecast` (`inkledger-forecast:dev`), 127.0.0.1:8601, volume `ml-models` at `/models`, 1 GB / 1 CPU (Q3). `pnpm dev:services` starts both profiles, `pnpm dev:down` stops both. CI's `docker` job builds the sidecar's `test` stage (its pytest, no model) and then the image, runs it with `FORECAST_FAKE=1` and checks `/health`, `/ready` and one `/forecast`; no new third-party action (the same pinned build-push action, its own cache scope).

## AC → test

| AC | Check | Command |
|---|---|---|
| AC-5.1 | `docker compose -f deploy/dev.yml config` is valid; `--profile ai --profile ml config` lists 3 services | `pnpm test` → `deploy/dev.test.ts` "the dev stack declares db, ai and ml" (parses the YAML) |
| AC-5.2 | `pnpm dev:db` → healthy on 54331; `pnpm dev` migrates the new db | manual, written into LOOP.md |
| AC-5.3 | `env.ts` reads every new variable with its default | `api/lib/env.test.ts` "new service variables have safe defaults" |
| AC-5.4 | CI `docker` job: forecast `/health` 200 with FORECAST_FAKE | CI |
| AC-5.5 | data moved · `pnpm dev` on 54331 shows the same notes, issues and worklogs; `jtt-db` untouched (its databases and volume as before) | manual, counts per table written in LOOP.md |
| AC-5.6 | `CONTRIBUTING.md` and `docs/dev/` · say how to start the db and the services, and that Ollama in Docker on a Mac has no Metal | review, written in LOOP.md |
| AC-5.7 | every batch of this doc · `git diff -- deploy/staging.yml` empty, no `jtt` name touched | review, written in LOOP.md |

## Traceability (every R has its ACs)

| R | AC |
| --- | --- |
| R-5.1 | AC-5.1 |
| R-5.2 | AC-5.2 |
| R-5.3 | AC-5.3 |
| R-5.4 | AC-5.5 |
| R-5.5 | AC-5.4 |
| R-5.6 | AC-5.6 |
| R-5.7 | AC-5.7 |

## Batches
1. `deploy/dev.yml` (db) + scripts + docs. No data is moved. AC-5.1, 5.2.
2. Moving the data. After Q1.
3. Profile `ai` + `env.ts` + `.env.example`. AC-5.3.
4. Profile `ml` + CI. AC-5.4.

## Open questions
- **Q1, blocks 2:** is it OK to move `inkledger_dev` out of `jtt-db` with a read-only dump? **Answer 2026-10-30:** superseded. The user logs time on the production db from dev :3000: back up `jtt` (`pg_dump -Fc`), stop the `jtt` container (no parallel sync, old image can't start on the newer schema anyway), point dev `.env` at `jtt` with `ALLOW_MIGRATE_PRODUCTION_DB=1`. Rollback: `pg_restore` the dump and start `jtt`. e2e throwaway dbs move to a separate container `inkledger-test-db` (127.0.0.1:54331, `E2E_DATABASE_URL`); `inkledger_dev` is kept as is.
- **Q2, blocks staging and prod:** when should Ollama and the forecast sidecar go to staging or the new prod?
- **Q3, not blocking:** memory and CPU limits per service. Defaults: Ollama 8 GB / 4 CPU, ml 1 GB / 1 CPU. **Answer 2026-10-30: as proposed** (Ollama 8 GB / 4 CPU, ml 1 GB / 1 CPU).

---
