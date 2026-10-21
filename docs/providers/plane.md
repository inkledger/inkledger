# Plane

Status: **experimental**. The adapter was built against a simulator written from Plane's public API documentation (REST v1); it has not run against a real workspace. The assumptions to check are listed in `docs/dev/spikes.md`, section "Plane" (see [What is not verified yet](#what-is-not-verified-yet)).

## What inkledger reads

- **Work items assigned to you**, in every project of the workspace you can see, keyed by the project's identifier and the item's number (`PROJ-12`). Completed and cancelled items are included; archived and deleted ones, and drafts, are not. Archived projects are skipped.
- For each item: title, link, state, project, priority (Urgent, High, Medium, Low; "None" is left empty), labels, assignees, creator, start and due dates, and when it was created, updated and completed.
- **States**, per project, with their category taken from Plane's state group (backlog, unstarted, started, completed, cancelled; intake is triage), never from the state's name: a project may call them anything.
- The **description** and the **comments** (HTML, shown as they are), and the item's **history** (state, title, assignee and label changes).
- **Time**: the worklogs on an item (everybody's), and your own worklogs of the last 30 days. Plane keeps whole minutes on a day.
- Text search across the work items you can see in the workspace.

## What inkledger writes

- A move to another state of the item's project (any state, set directly; intake is not offered).
- **Comments.** Plane takes HTML; inkledger sends paragraphs (the text escaped). Markdown formatting beyond paragraphs (bold, lists, code, links…) arrives as plain text and the app says so.
- **Worklogs**: a new one on a day, in whole minutes (rounded to the nearest minute, at least one). Plane's worklogs are not changed or deleted by inkledger.

Nothing else is written.

## The token and the address

1. In Plane, open your avatar, **Settings**, **Account**, **API tokens** (Personal access tokens), **Add API token**. Give it a name and an expiry, and copy the token (`plane_api_…`) when it is shown: it is shown once. (The menu names are from the documentation, unconfirmed.)
2. The token acts as you, in every workspace you belong to; Plane has no narrower scopes for it.
3. The connection asks for the **API address with your workspace's slug**:
   - Plane cloud: `https://api.plane.so/<workspace>` (the slug is the first part of your Plane address: `app.plane.so/<workspace>/…`).
   - Self-hosted: `https://your-plane/<workspace>`, or `https://your-plane/prefix/<workspace>` when it is served under a path.
   The slug can also be set in the connection's `workspace` option; the address then carries only the server.

Links pasted from Plane (`https://app.plane.so/<workspace>/browse/PROJ-12/`, and the older `…/projects/<id>/issues/<id>`) are recognised for the connection's own workspace and server only.

## Self-hosted notes

- inkledger's server must reach your Plane; a server on a private network works when inkledger runs on that network. The cloud is reached on public addresses only.
- Avatars that Plane sends as paths are resolved against your server's address.
- The API paths are the current ones (`/api/v1/…/work-items/`). An older self-hosted version that only has the deprecated `/issues/` paths is not supported yet.

## Limits to know

- Plane allows **60 requests a minute** per API key. inkledger reads 50 items per page and waits when Plane answers "too many requests" for as long as it says.
- Plane has no way to list only your items on its side: every project's items are read newest change first, and the first sync reads them all (later syncs stop at the last sync). A big workspace takes several minutes the first time.
- Your own time of the last days is found by reading the worklogs of the items assigned to you that changed in that window, one call per item. Time you logged on an item that has not changed for a month, or is not assigned to you, is not found by that feed (it shows on the item itself).
- An item you lose access to, or that is deleted, reads as "not found". A deletion is learned from a read or a webhook, not from the list.
- A project's identifier can be renamed: its items' keys change, and a pasted old key stops working (the items are still followed by their id).
- A worklog is whole minutes: logging 90 seconds files 2 minutes.

## What is not verified yet

Everything above was written from the documentation and exercised on a simulator. The list of assumptions to check on a real account, each with what changes if it holds or not, is in [`docs/dev/spikes.md`](../dev/spikes.md#plane-built-on-a-simulator-not-verified-on-a-real-account). The main ones: the work item paths and the lookup by key, whether the list can be filtered by assignee, the day on a worklog (and whether worklogs can be changed or deleted, and on which plan), how to list a person's time, the rate-limit headers, and the webhook headers (`X-Plane-Signature`, `X-Plane-Delivery`, `X-Plane-Event`).
