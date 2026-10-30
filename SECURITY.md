# Security policy

## Reporting a vulnerability

Please report security issues privately, through GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository ("Security" tab → "Report a vulnerability"). Do not open a public issue.

Include what you found, how to reproduce it, the version (commit) you tested, and the impact you
expect. You will get an answer within a week; fixes are released as soon as they are ready and
credited in the release notes unless you ask otherwise.

## Supported versions

inkledger is self-hosted and released from `main`: only the latest release gets fixes. Native apps
built from this repository are unsigned development builds until signing is set up (see
[docs/native.md](docs/native.md)).

## Scope

In scope: the server (`api/`), the web app (`src/`), the native shell (`src-tauri/`), the Docker
image and the build and release scripts. Trackers' own APIs, and modules from third parties, are
out of scope.

## What the server does to stay safe

The main safeguards are listed in the README ("Security and privacy"). For operators:

- Set `SESSION_SECRET` and `CREDENTIALS_KEY`, and keep `CREDENTIALS_KEY` with your backups, but
  apart from them: copies of pinned mails (an opt-in, `docs/outlook.md`) are in the database
  encrypted with it, so a `pg_dump` holds them only as ciphertext, and losing the key loses them.
- The first admin gets a random password in production (its file path is logged); change it.
- Set `REMOTE_ALLOWED_HOSTS` to the self-hosted trackers you use.
- Backups are written readable by the server's user only: keep them that way.
