# Runbook: rotating SESSION_SECRET and CREDENTIALS_KEY

How to change the server's secret keys without losing stored credentials. Follow the steps in order; each step says how to check it before moving on.

## What each key protects

| Key | Protects | When it changes without preparation |
| --- | --- | --- |
| `CREDENTIALS_KEY` | Every sealed value: tracker credentials and webhook secrets (`connections`), mailbox sign-ins (`mail_accounts`), mail copies (`mail_copies`), idea pictures (`idea_files`). It also signs share links. | Nothing sealed opens any more: connections show "unreadable" and must be reconnected; mailbox sign-ins, mail copies and idea pictures are lost |
| `CREDENTIALS_KEY_OLD` | Nothing new. It still opens values sealed with the previous key, until they are sealed again | Removing it too early has the same effect as above for the values still sealed with it |
| `SESSION_SECRET` | Module code tokens (minutes long) and exported module progress files. **If `CREDENTIALS_KEY` is not set**, every sealed value and every share link uses a key derived from it, and so does the oldest connection format | Open module frames reload; progress files exported earlier no longer import. Without `CREDENTIALS_KEY`, also everything in the row above |

Sign-in sessions are random identifiers stored as hashes: changing either key does not sign anyone out.

**Safe order: set `CREDENTIALS_KEY` first, seal everything with it, then change `SESSION_SECRET`.**

## Tools

Both commands run in the app container (or `pnpm exec tsx api/cli.ts …` from a checkout), with the same environment as the server:

```bash
docker exec <app-container> node dist/cli.js keys-status
docker exec <app-container> node dist/cli.js reseal            # dry run: counts only
docker exec <app-container> node dist/cli.js reseal --apply    # writes
```

- `keys-status` prints, for each sealed column, how many values open with `CREDENTIALS_KEY`, `CREDENTIALS_KEY_OLD`, the key derived from `SESSION_SECRET`, or none ("unreadable"). It warns when anything still depends on `SESSION_SECRET` or `CREDENTIALS_KEY_OLD`. It changes nothing.
- `reseal` seals every value that opens, but is not yet sealed with the current key, again with the current key. It lists the values no key opens by table, column and row id, and leaves them as they are. It is a dry run unless `--apply` is given. It exits with status 2 when unreadable values exist. It is safe while the server runs: a value the server rewrites in the meantime is skipped and reported as "changed meanwhile"; run it again.
- At every start the server also seals connection secrets again on its own. The other columns are only sealed again by `reseal --apply`.

A change to the environment file needs the container to be recreated (`docker compose up -d`), not just restarted.

## Before any rotation

1. Take a database backup and keep it off the host:
   `docker exec <db-container> pg_dump -U <db-user> -Fc <db-name> > before-rotation.dump`
2. Store the current values of `SESSION_SECRET`, `CREDENTIALS_KEY` and `CREDENTIALS_KEY_OLD` with that backup. A backup holds sealed values: restoring it later needs the keys that were in use when it was taken.
3. Run `keys-status` and keep the output as the baseline. Note any "unreadable" values: they are not caused by the rotation.

## Procedure A: first CREDENTIALS_KEY (the server has none yet)

1. Generate a key: `openssl rand -hex 32`.
2. Set `CREDENTIALS_KEY=<new key>` in the environment file. **Leave `SESSION_SECRET` unchanged.** `CREDENTIALS_KEY_OLD` is not needed: the key derived from the unchanged `SESSION_SECRET` still opens the old values.
3. Recreate the app container. Check that `/api/health` answers.
4. Run `reseal` (dry run), then `reseal --apply`.
5. Run `keys-status`. Expected: "New values are sealed with: CREDENTIALS_KEY", the `SESSION_SECRET` count is 0 in every column, and there is no warning about `SESSION_SECRET`. Do not continue while that warning is shown.
6. Change `SESSION_SECRET` to a new random value (`openssl rand -hex 32`) and recreate the container.
7. Run `keys-status` again: the counts are the same as in step 5. Users with module frames open reload them.

## Procedure B: rotating CREDENTIALS_KEY

1. Move the current key to `CREDENTIALS_KEY_OLD` and put a new one (`openssl rand -hex 32`) in `CREDENTIALS_KEY`.
2. Recreate the app container. Check `/api/health`.
3. Run `reseal`, then `reseal --apply`.
4. Run `keys-status`. Expected: the `CREDENTIALS_KEY_OLD` count is 0 in every column, and there is no warning about `CREDENTIALS_KEY_OLD`.
5. Wait one day if share links matter (they last at most a day and are still accepted with the old key), then remove `CREDENTIALS_KEY_OLD` and recreate the container.
6. Run `keys-status` once more: no warning except values that were already unreadable in the baseline.

## Procedure C: rotating SESSION_SECRET only

Run `keys-status` first. If it warns that `CREDENTIALS_KEY` is not set, or that values open only with the key derived from `SESSION_SECRET`, do Procedure A instead. Otherwise change `SESSION_SECRET`, recreate the container, and check that `keys-status` is unchanged.

## When values became unreadable

- Put the key they were sealed with back as `CREDENTIALS_KEY_OLD` (for values sealed under an old `SESSION_SECRET`, put that old secret there), recreate the container, then run `reseal --apply` and `keys-status`. Connections marked "unreadable" work again once their secret opens.
- If no key is left, the affected users reconnect their trackers and sign in to their mailbox again; mail copies and idea pictures sealed with the lost key cannot be recovered.
- To go back completely, restore the backup taken before the rotation, with the keys stored next to it.
