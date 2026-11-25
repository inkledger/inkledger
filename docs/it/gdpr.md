# Data protection (GDPR) notes

Not legal advice. It describes what the software holds and does, so an operator can complete their own records.

## Roles

inkledger is self-hosted: the organisation that runs the server is the **controller** and decides purposes and retention. The project ships no processor: it receives no data and has no telemetry. Services the server may call are optional and listed in [outbound.md](outbound.md); each one you enable (tracker vendors, Microsoft, a hosting or backup provider, the module store) belongs in your own processor and sub-processor list, with its own agreement.

Choose and record your own lawful basis (for work time tracking, typically the employment contract or a legitimate interest, with works-council or local-law rules where they apply).

## What is held

Account details (username, display name, email, role), sign-in records, time entries, timers, plans, notes, to-dos, ideas, tracker connections (credentials sealed), pinned mails (opt-in, sealed), and the audit log (actor, client address). Groups, encryption and retention per table: [data-flow.md](data-flow.md).

## Retention

Automatic purges (every 6 hours): sessions at expiry, deleted worklogs, notes and ideas after 30 days in the trash, dismissed notifications 30 days, timer runs 30 days, unused module files 30 days, webhook intake 2 days, orphaned mail copies 7 days, mail read records 365 days, flow analysis 30 days raw and 365 days aggregated (per user), audit log 400 days by default (minimum 90, Settings → Audit log). Everything else stays until it is deleted. Backups keep what the database held when they were taken, for the newest N files (default 14): deleting data does not change older backups.

## Data subject rights

- **Access and portability: export (available).** `users.exportData`, served as `GET /api/users/<id>/export`, streams a ZIP.
  - Who: the person from Settings → Account ("Your data"), or anyone holding `exportUserData` from Settings → Users.
  - What it holds:
    - `account.json`: the account, without its password hash.
    - `connections.json`: tracker connections as metadata. Sealed secrets and webhook secrets are left out.
    - `data/<table>.json` for every table of the person's: worklogs, timers, planned entries, notes and their versions, to-dos, ideas, pinboards, pinned mails (metadata only, not the sealed copies), settings, schedules, views, module storage, layout. Worklogs, deleted worklogs, timers, timer runs, planned entries and to-dos also come as CSV.
    - `audit_events.json`: the audit events the person did, or that are about them.
    - `manifest.json`: every file with its row count, and the tables left out with why (hashed session and device tokens, invite links, add-in keys, the tracker's own history).
  - Binary file contents (idea pictures, module files) are not included.
  - Every export is an audit event (`users.exportData`), and so is every refused attempt.
  - Time logged in a tracker is exported from the tracker.
  - Which table counts as a person's is fixed in `api/gdpr/policy.ts`. A test fails when a table with a `user_id` column, or a new reference to an account or a connection, isn't listed there.
- **Rectification:** users edit their own entries and settings; an admin renames accounts.
- **Restriction:** an admin can turn an account off (it keeps its data but cannot sign in).
- **Erasure (available).** `users.erase`, from Settings → Users → "Erase account…".
  - Who: it needs `eraseUserData` and must be confirmed by an owner. The person erasing must be an owner and must type the account's username, which the server checks too. It is never one's own account, and never the last active owner.
  - How it runs, in one transaction:
    1. The account row is locked, so writes for it wait until the erasure ends, and its connections are archived.
    2. Their rows are deleted table by table, each table before the ones it points at. `connection_id` foreign keys don't cascade, so the order matters.
    3. The connections are deleted, together with the rows that hang off them (projects, sync state, mappings).
    4. The account is deleted last.
  - The audit log is not deleted. In the rows the person did, the actor label becomes `erased-user-<id>`, and the client address and device hash are cleared. In the rows about them, their username, name and email in the recorded values are replaced the same way.
  - Pseudonymised rows are marked. The hash chain still verifies: each row keeps its link to the one before, and the content hash is no longer checked for a marked row. The database trigger allows only this change, and only during an erasure.
  - The erasure is itself an audit event (`users.erase`). It names the id and the counts of what went, never who it was.
- **What erasure does not reach:**
  - the numeric id in audit rows;
  - copies of the audit log already written to the JSONL file mirror (`/app/data/audit`);
  - older backups, until they are pruned;
  - anything already in a tracker (it is the tracker's data).
- **Audit log:** apart from the pseudonymisation above, it is append-only for integrity. Entries are removed only by the retention purge.

## Security measures

See [security-one-pager.md](security-one-pager.md). Breach handling: [runbook-incident.md](runbook-incident.md).

## Sub-processor list (template)

| Service | Purpose | Data sent | Location | Agreement | Optional |
| --- | --- | --- | --- | --- | --- |
| <tracker vendor> | Time and issue sync | What users log and read | | | Per connection |
| <hosting provider> | Runs the server | Everything | | | No |
| <backup storage> | Copies of backups, if you ship them | Everything (encrypt it) | | | Yes |
| Microsoft | Mailbox search | Search queries, mail ids | | | Yes (`MS_CLIENT_ID`) |
| Open-Meteo | Weather for modules | Coordinates rounded to 0.1 degree | | | Yes (`WEATHER=off`) |
| Module store | Licences | Licence requests | | | Yes (`STORE_URL=off`) |
