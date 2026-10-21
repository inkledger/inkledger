# Gitea and Forgejo

Status: **experimental**. The adapter was built on a simulator written from the official API documentation and has not been run against a real server. The assumptions to check are listed in `docs/dev/spikes.md` ("Gitea / Forgejo").

Forgejo (the Gitea fork) has the same REST API under `/api/v1`; everything here applies to both.

## What inkledger reads

- **Your issues**: the issues assigned to you, in every repository you can see, open and closed, found through the instance-wide issue search and read again from a checkpoint (the last pass, less a minute). Pull requests are left out (Gitea lists them as issues too).
- **Keys**: `owner/repo#12`, the way Gitea writes a reference. Pasting `https://your-gitea/owner/repo/issues/12` finds the same issue. A renamed repository keeps its issues: inkledger identifies them by Gitea's global issue id and learns the new key.
- **Title, description, labels, assignees, reporter, dates, status** (open or closed). The description and comments are read as GitHub-flavoured Markdown.
- **Comments**, and **history** (closing and reopening, title changes, labels, assignees, milestone), from the issue timeline.
- **Tracked time** you logged: your entries of the last 30 days, and every entry on an issue you open (other people's entries are shown, never changed).
- **Search** by text in the issues you can see.

## What inkledger writes

- **Open and close** an issue (the two states Gitea has).
- **Comments** (Markdown).
- **Tracked time**: a new entry (start and duration), and deleting your own. Gitea has no way to change an entry, so a changed one is deleted and logged again. Gitea's tracked time has no note, so the note stays in inkledger only.
- **Watch / unwatch** an issue (subscription).

Nothing else is written: no new issues, labels or assignees yet.

## Token

Create a personal access token in Gitea: Settings, Applications, "Generate New Token". Scopes:

| Scope | For |
| --- | --- |
| `read:user` | who you are |
| `read:issue` | issues, comments, timeline, tracked time |
| `write:issue` | state changes, comments, time, subscriptions |
| `read:repository` | listing repositories (planned) |

A token without `write:issue` still reads: writes answer "forbidden" and inkledger says which scope is missing. Private repositories need a token of an account that can see them.

The connection asks for the **API root**: `https://your-gitea/api/v1` (a Gitea under a sub-path: `https://host/gitea/api/v1`).

## Self-hosted notes

- Time tracking must be switched on for the repository (Settings, Advanced Settings, "Enable time tracking"), and you must be able to write to it or be assigned the issue. Otherwise logging time is refused and inkledger says so.
- Gitea has no rate limit of its own. A reverse proxy in front of it may; inkledger waits when it answers 429 with `Retry-After`.
- Gitea builds the page links from its `ROOT_URL`. If a proxy hides that address, the links name the wrong host: inkledger keeps the host you connected with.
- A server in a different time zone than yours is fine: dates are compared as instants, and your entries stay on the day you logged them.
- Archived repositories can be read but not changed.
- Choose repositories to leave out in the connection's options (`excludeRepos`, `owner/repo`).

## Not verified yet

Everything above is from the documentation. In particular: the exact answers of the issue search and `/user/times`, `created` being honoured when logging time, the status codes of a rename redirect and of subscriptions, the timeline's field names, and Forgejo's differences. Project boards (columns) and scoped labels as workflow statuses are declared for Gitea but not active: Gitea's REST API has no project endpoint known to the adapter, and scoped labels need your own category mapping. Webhooks (signature `X-Gitea-Signature`) are implemented as pieces (`api/providers/gitea/webhook.ts`) but nothing receives them yet.
