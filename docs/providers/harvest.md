# Harvest

Status: **experimental**. The adapter was built against a simulator written from Harvest's API v2 documentation and has not met a real account yet (see [What is not verified yet](#what-is-not-verified-yet)). Until you allow writes on the connection, nothing is sent to Harvest.

Harvest is a **time sink**: it only receives time. It has no issues here. Every worklog you log on one of your trackers is also filed on Harvest, in the background, after the fact.

## What inkledger sends

For each worklog, one Harvest **time entry**:

- **Project and task.** Harvest requires both. You map each of your tracker's projects (or one default) to a Harvest project and task; the choices are the project assignments of your own Harvest user, found by searching. A worklog whose project has no mapping and no default stays "no target" until you map it.
- **Day and length.** The day is the day of the worklog in *your* time zone (Harvest's `spent_date` is a date with no zone). The length is sent as decimal hours with two decimals, so in steps of 36 seconds (see [Rounding](#rounding)).
  - On an account that uses **timestamps**, the start and end are sent instead (`started_time`, `ended_time`, to the minute). An entry cannot cross midnight: such a worklog is refused with a reason.
- **Notes.** Always `[KEY] Issue title`, then a blank line and the worklog's comment if there is one. The key and title come first so the entry reads on its own in Harvest.
- **External reference.** Harvest's `external_reference`: `id` the issue's id on its tracker, `group_id` its project on the tracker (when known), `account_id` the tracker type and connection (`jira:3`), `permalink` the issue's link. Harvest shows it as a link on the entry.

Changing a worklog updates the same entry (the `[KEY] title` line stays, the comment and time change). Deleting a worklog deletes the entry; an entry already gone counts as deleted.

## What inkledger reads

- Your entries over a period, by spent date, and the entries changed in the last 7 days (Harvest's `updated_since`), only yours (an administrator's list would otherwise hold everyone's).
- An entry's issue: from its external reference, else from the `[KEY]` its notes start with; neither: it is shown with no issue.
- Whether an entry is billable, approved (Timesheet Approval), invoiced or locked, and why. These entries are shown as not editable; changing or deleting one is reported as a conflict.
- Running timers are **not** read: their time is still counting. They arrive after you stop them.

## The token

A **personal access token** and your **account id**, both from Harvest's developer page.

1. Open <https://id.getharvest.com/developers> and sign in.
2. **Create new personal access token**, name it (for example `inkledger`) and choose the account it is for.
3. Copy the **token** and the **account id** shown beside it (a number).
4. In inkledger: Settings, Connections, add Harvest, paste the token and the account id.

The token acts as you: it sees the projects and tasks you are assigned to and can log time for you. It sends `Authorization: Bearer <token>`, `Harvest-Account-Id: <account id>` and a `User-Agent` that names inkledger.

## Rounding

Harvest keeps hours as a decimal with two decimals, so a duration is sent in steps of 36 seconds, rounded to the nearest: 90 seconds becomes 0.03 h and reads back as 108 seconds; 1 h 1 min becomes 1.02 h (12 seconds more). A worklog under 18 seconds is refused ("rounds to nothing"), and so is one over 24 hours. Timestamp accounts keep minutes instead (a length rounds to the nearest minute).

## Limits to know

- Harvest allows **100 requests per 15 seconds** per account; after a "too many requests" answer inkledger waits the time Harvest asks for (`Retry-After`).
- Harvest has **no idempotency key**. inkledger sends one entry at a time and reconciles, but a create whose answer never arrived can land twice on Harvest; the period reconciliation finds the extra entry.
- An entry in a **closed timesheet period**, **approved** or **invoiced** cannot be changed from here. Change it in Harvest.
- A project that is archived, or a task no longer assigned to it, refuses new entries ("invalid"); map another project or task.
- A duration account has no time of day: such an entry reads back as starting at the beginning of its day in your time zone.

## What is not verified yet

Everything above was written from the documentation and exercised on a simulator. The list of assumptions to check on a real account, each with what changes if it holds or not, is in [`api/providers/harvest/SPIKES.md`](../../api/providers/harvest/SPIKES.md). The main ones: how hours are stored (two decimals or seconds), whether `hours` is accepted on timestamp accounts, the exact refusal for locked and approved entries, which status a wrong account id answers, the shape and requirements of `external_reference`, and the 100 per 15 seconds budget.
