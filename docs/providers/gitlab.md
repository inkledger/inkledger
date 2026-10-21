# GitLab

Status: **experimental**. The adapter was built against a simulator written from GitLab's documentation and has not met a real account yet (see [What is not verified yet](#what-is-not-verified-yet)).

## What inkledger reads

- **Issues assigned to you**, on gitlab.com or a self-managed server, in every project you can see. An issue's key is its full reference, `group/subgroup/project#12`; the number is the project's own. Closed issues are read too.
- **Status.** GitLab has two states, open and closed (category *todo* and *done*). Optionally one **scoped label set** carries the workflow (`workflow::doing`): you list its values and the category of each in the connection's options. inkledger never guesses what a label means from its name; values you don't list are ignored, and an issue with two labels of the set shows as Open.
- **Description and comments** (GitLab Flavored Markdown, shown as GLFM). System notes ("changed the description", "assigned to …") are not comments and are left out.
- **History**: label, state and milestone changes of an issue.
- **Moved issues.** When an issue is moved to another project, the old one stays behind, closed; inkledger follows it to the new issue.
- **Time**: the time entries ("time spent") you logged in the last 30 days, and those on an issue, **read only**. Writing time on GitLab waits for a check on a real account.
- **Search**: text search over issues assigned to you or written by you.
- Webhooks (issue and comment events) are prepared but not switched on.

## What inkledger writes

- **Open, close and reopen** an issue; **move it along the scoped label set** if you configured one (the old label of the set is removed).
- **Comments** (written as Markdown). A line starting with `/` is escaped (`\/close`), because GitLab would otherwise run it as a quick action (`/close`, `/assign`, `/spend 1h`) instead of keeping the text.
- **Watch** an issue (subscribe / unsubscribe).

Nothing else is written. Time is never written to GitLab.

## The token

inkledger uses a **personal access token** (sent in the `PRIVATE-TOKEN` header).

1. On GitLab, open your avatar, **Edit profile**, **Access tokens**, **Add new token**.
2. Name it (for example `inkledger`) and set an expiry (GitLab limits it; note the date, the connection asks for a new token after it).
3. Scopes:
   - **`api`** to read and to change issues and add comments, open/close, watch;
   - **`read_api`** is enough if you only want to read (writes will then be refused with "forbidden").
4. Copy the token when GitLab shows it (it is shown once) and paste it in inkledger.

Use your own personal token, not a project or group access token: those act as a separate bot user, so "assigned to me" would be empty.

## Self-managed servers

- The API address is `https://your-host/api/v4` (with your path prefix if the site is served under one, `https://host/gitlab/api/v4`).
- inkledger's server must reach it; a server on a private network works when inkledger runs on that network.
- Links pasted from the instance (`https://your-host/group/project/-/issues/12`) are recognised only for the connection's own address.
- Avatars that GitLab sends as paths are resolved against the instance's address.
- Time reading and the scoped-label workflow need GraphQL and GitLab 16 or later (see below).

## Limits to know

- GitLab's rate limits (gitlab.com allows a few thousand calls per minute per user) are respected: after a "too many requests" answer inkledger waits the time GitLab asks for.
- An issue you lose access to reads as "not found": GitLab answers 404, not "forbidden", for what you can't see.
- A renamed project keeps its issues; a pasted link under the old path stops working until it is replaced.

## What is not verified yet

Everything above was written from the documentation and exercised on a simulator. The list of assumptions to check on a real account, each with what changes if it holds or not, is in [`docs/dev/spikes.md`](../dev/spikes.md#gitlab-built-on-a-simulator-not-verified-on-a-real-account). The main ones: the GraphQL timelog queries and their day boundaries (UTC days), the lookup of a moved issue's successor, how quick actions in comments behave when escaped, the rate-limit headers, the webhook headers, and whether time can be written on a chosen day.
