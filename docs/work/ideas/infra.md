# Spec: services in containers, a clean machine

Status: planned 2026-10-29, not started. Open questions are asked when their batch is reached (README, R-0.12).


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
- **Q1, blocks 2:** is it OK to move `inkledger_dev` out of `jtt-db` with a read-only dump?
- **Q2, blocks staging and prod:** when should Ollama and the forecast sidecar go to staging or the new prod?
- **Q3, not blocking:** memory and CPU limits per service. Defaults: Ollama 8 GB / 4 CPU, ml 1 GB / 1 CPU.

---
