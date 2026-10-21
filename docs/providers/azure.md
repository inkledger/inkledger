# Azure DevOps

Status: **experimental**. The adapter was built from Microsoft's REST documentation (api-version 7.1) and tested only against a simulator. It has not been run on a real account; the assumptions still to check are listed in [docs/dev/spikes.md](../dev/spikes.md) under "Azure DevOps".

## What inkledger reads

- **Your work items**: everything assigned to you (`[System.AssignedTo] = @Me`, any type and state, Removed included), in every project your token can see. Each pass asks only for what changed since the last one (with five minutes of overlap) and reads them 100 at a time.
- **Keys**: `Project#12`. The number is unique across the whole organization; the project is only part of the key. If a project is renamed or an item is moved, its key changes and it stays the same issue. A bare number (`12`), a `#12` and the links of the web app (work item, board and backlog cards) are understood too.
- **Status**: the work item's State, with Azure's own category: Proposed is *to do*, In progress and Resolved are *doing*, Completed is *done*, Removed is *cancelled*. A state that is not in the type's list counts as *to do*.
- **Fields**: title, type, priority (1 to 4), tags (split on `;`), due date, original estimate and completed work (hours, shown as seconds), creator, assignee, dates, the description (HTML), and the comments (HTML).
- **History**: the work item's updates, field by field.
- **Search**: by words of the title (or by number) across everything the token sees, and your own WIQL queries, run as written.
- **Deleted items**: an incremental pass also asks the reporting feed which items were deleted since the last pass.

## What inkledger writes

- **State changes**, along the transitions the work item type allows (or to any state, in a process that lists none). A state that asks for extra fields (a reason, remaining work) is refused by Azure and shown as an error; complete it on the web.
- **Time**: inkledger keeps its own entries and adds them to **Completed Work** (hours). It reads the work item's revision first and writes with a `test /rev` guard, so a write that races with another change (any change: a title edit and a comment are new revisions too) is refused as a conflict and read again, never lost. Only types that have the field take time (Task and Bug in the standard processes; a User Story refuses it).
- **Comments**, as HTML paragraphs. Markdown formatting (bold, lists, links, code, tables…) is not converted yet: it goes as plain text and inkledger tells you which parts were approximated.

It does not create or edit work items, assign, label or watch them.

## The token

Make a **personal access token** at `https://dev.azure.com/{organization}/_usersSettings/tokens` (or *User settings > Personal access tokens*), for the organization you use, with these scopes:

- **Work Items: Read & write** (read is enough if you never log time or move items from inkledger).
- **Project and Team: Read** (inkledger reads the project list to give each project a stable id; without it everything works but a project is then identified by its name).

Set an expiry you can live with: an expired token shows up as an authentication error and the connection asks you to reconnect. The token is stored encrypted and sent as Basic authentication with an empty user name, as Azure DevOps documents.

The connection's address is `https://dev.azure.com/{organization}`.

## Azure DevOps Server (self-hosted)

Use the collection's address, for example `https://tfs.example.com/tfs/DefaultCollection`, and a personal access token made on that server. Notes:

- Links of the web app are recognized under that address only.
- Older servers send people as `Name <user@example.com>`: they are read, and the unique name is used as their id.
- The REST version asked for is 7.1. A server release that doesn't offer it needs a lower one; this is one of the things still to check.
- Every request goes through the shared safe fetch (redirects re-checked). Telling a private-network server apart from a public one is not wired for this provider yet.

## Service hooks (webhooks)

Webhooks are only an accelerator: inkledger never relies on them. When they are connected, create a subscription of the **Web Hooks** consumer for *Work item created / updated / deleted / commented*, with a basic-auth user name and password; inkledger accepts a delivery only if it carries exactly those. The event is a signal: the item named in it is read again.

## Not verified yet

Everything. In particular: the token scopes above, the refused-token answers, the exact WIQL date behaviour, the shape of the reporting feed for deleted items, how inherited processes report transitions, the failed-revision status code, the preview version of the comments API, rate-limit headers, Server versions, and the service-hook payloads. See the spikes list for what each outcome decides.
