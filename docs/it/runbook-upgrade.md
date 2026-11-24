# Runbook: upgrading the Docker stack

`scripts/docker-update.mjs` (`pnpm docker:update`) updates a running Docker stack in place: it backs up the database, builds or pulls the new image, swaps the app container, waits for it to be healthy and rolls back on its own when it is not. This page describes what it does and how to run it safely.

## What the script assumes

It targets the stack in `deploy/staging.yml` (compose project `inkledger`, containers `inkledger` and `inkledger-db`, health check on `http://127.0.0.1:47824/api/health`). A stack with other names or ports needs those constants adapted in the script before use.

| Variable | Default | Meaning |
| --- | --- | --- |
| `INKLEDGER_ENV_FILE` | `.env.inkledger` in the checkout | The stack's environment file; the script refuses to run without it |
| `INKLEDGER_BACKUP_DIR` | `~/Backups/inkledger` | Where the pre-update dump is written (folder mode 0700, file mode 0600) |
| `INKLEDGER_RELEASE_IMAGE` | unset | A published image to pull and run instead of building the current checkout |

## Options

| Command | Effect |
| --- | --- |
| `pnpm docker:update --dry-run` | Prints every step and changes nothing |
| `pnpm docker:update` | Backup, build (or pull), swap, health gate, rollback if needed, prune |
| `pnpm docker:update --no-backup` | Skips the dump. A failed update that already migrated the database then cannot be rolled back automatically (see below) |
| `pnpm docker:update --rehearse-rollback` | Runs the full update, then rolls back as if the health check had failed, even if it passed |

## Before the update

1. Read the changelog for the target version.
2. Run `docker exec inkledger node dist/cli.js keys-status` and keep the output (see [key rotation](runbook-rotation.md)).
3. Run `pnpm docker:update --dry-run` and read the steps.
4. When building from a checkout, make sure the working tree is clean: uncommitted changes go into the image (the script warns about it).
5. If off-site copies are on, Settings → Backup shows a recent last off-site copy and a passed last drill (run one if it is older than a week) ([restore](runbook-restore.md)).

## What happens, step by step

1. **Backup.** `pg_dump -Fc` of the database into `INKLEDGER_BACKUP_DIR`. An empty or failed dump is deleted and the update stops with nothing changed.
2. **Migration count.** The script reads how many migrations the database has applied. If it can't, it stops with nothing changed.
3. **Keep the previous image.** The running image is tagged `:prev`.
4. **New image.** `docker build` of the checkout, or `docker pull` of `INKLEDGER_RELEASE_IMAGE`. Either way it is tagged with the commit and `:latest`.
5. **Swap.** Only the app container is recreated; the database keeps running. The new version applies its migrations at start (additive only).
6. **Health gate.** The script waits up to 120 seconds for `/api/health` to answer 200 (it answers when the server is up and its database answers).
7. **Prune.** Keeps `:latest`, `:prev` and the three most recent builds; removes dangling images and trims the build cache to 4 GB.

## Rollback

When the health gate fails (or with `--rehearse-rollback`), the script prints the last 40 log lines, then:

- If the migration count did not change, it tags `:prev` as `:latest` and starts it again.
- If the new version migrated the database (or the count can't be read), the previous image would refuse the newer schema. The script stops the app, drops and recreates the database, restores this run's dump, then starts `:prev`. Anything written by the new version after the dump is lost (it was unhealthy, so usually nothing).
- It waits up to 120 seconds for the previous image to be healthy and says so. It always exits with status 1 after a rollback.

Without a dump from this run (`--no-backup`) and with a migrated database, the script stops the app and prints the manual recovery commands instead of claiming a rollback:

```bash
docker exec inkledger-db psql -U inkledger -d postgres -c "DROP DATABASE inkledger WITH (FORCE)" -c "CREATE DATABASE inkledger OWNER inkledger"
docker exec -i inkledger-db pg_restore -U inkledger -d inkledger --no-owner < <dump made before the update>
docker tag inkledger:prev inkledger:latest && docker compose -p inkledger -f deploy/staging.yml up -d --no-deps inkledger
```

If there is no previous image (first install), nothing is rolled back and the stack is left as it is.

## Rehearsing the rollback

Run `pnpm docker:update --rehearse-rollback` on a staging copy before relying on rollback in production, and after any change to the update procedure. Expected result: the new image becomes healthy, the script rolls back to `:prev` (restoring the dump when migrations ran), reports "Rolled back", and the previous version answers on `/api/health` with the data as it was before. Then run a normal update.

## After the update

1. Open the app and check that sign-in and a tracker sync work.
2. `docker logs --tail 100 inkledger`: no errors at start.
3. `docker exec inkledger node dist/cli.js keys-status`: the same counts as before the update.
4. Keep the pre-update dump until the next successful update; copy it off the host if it is the only backup.
