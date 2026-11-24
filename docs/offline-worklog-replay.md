# A timeout is not a cancel: replaying worklogs without duplicating them

A tracker can accept a worklog and still let the HTTP response die on the way back. Treating that timeout as “the write failed” is how you create a second entry. Treating it as “the write succeeded” is how you lose the user's later changes.

inkledger takes a less convenient but more useful position: **a timeout is not a cancel, and it is not proof of success either**. The server keeps the intent locally, replays it in order, and checks what actually reached the tracker before creating another entry.

This is the recovery protocol behind that behavior, with its limits included.

## 1. Keep the intent before trusting the network

A create starts as a local worklog with a temporary `new-…` remote ID. The server then calls the tracker. Only a certain refusal deletes that local intent. A timeout, an unreachable tracker or an answer outside the expected contract leaves a recoverable operation behind: the outbox entry exists and the worklog is marked `pending-N`.

That distinction matters. A network exception does not tell you whether the remote side did the work. The local `pending` state preserves the question instead of guessing an answer.

The same principle applies after the tracker accepted the write but the local link could not be recorded: replay must link the existing remote entry rather than create another one.

Relevant code: [`createThrough`](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.ts#L71-L117), including the `neverSent` distinction, and the [`pending-N` contract](https://github.com/inkledger/inkledger/blob/v0.1.0/contracts/types.ts#L21-L27).

## 2. Replay is ordered, and being offline is not an attempt

Replays read a connection's outbox oldest first and stop at the first transient network error. Being offline does not consume an attempt: there is no point punishing a worklog because the tracker cannot be reached. Other failures increment the counter and processing can continue; ten failed attempts is the queue's upper bound.

Two details prevent a replay from becoming a race:

- one replay runs per connection;
- every outbox entry is claimed in Postgres before it is sent.

The claim is an atomic `UPDATE` allowed only when `claimedAt` is null or older than five minutes. Another process holding a fresh claim causes the replay to stop. If a process dies mid-send, its claim expires and another process can recover the entry. This is what lets two inkledger processes share one database without both posting the same operation.

Relevant code: [`replayContract` and the ordered replay loop](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.ts#L477-L587), [`CLAIM_TTL_MS`](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.ts#L178-L193), and [`MAX_OUTBOX_ATTEMPTS`](https://github.com/inkledger/inkledger/blob/v0.1.0/contracts/types.ts#L26-L27).

## 3. Adopt before creating

Before re-posting a create, replay asks the tracker for its existing worklogs and looks for an entry that could be the earlier attempt. The comparison always includes the same author, start (or local day) and duration within the provider's rounding rules, plus no conflicting link to another local worklog.

Providers that stamp the exact start can identify the entry by that precise second. When a tracker exposes only the day of a worklog, inkledger also requires the same words after whitespace normalization and a known creation time. An entry created more than five minutes before the operation was queued is never adopted.

The outbox separately records the values used by that particular send and, where needed for a lost create or delete, the bounds within which it could have landed. It does not assume those values are the ones currently shown in the editor.

When a match is credible, the replay **adopts** the remote entry and links it locally. It does not create a second one. A provider with no way to list existing worklogs cannot use this recovery path and must not invent a match.

Relevant code: [`ADOPT_WINDOW_MS` and `sendBounds`](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.ts#L195-L199) and [`adoptLanded`](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.ts#L220-L289).

## 4. Legitimate twins are the hard part

Two worklogs can have the same start, duration, author and even the same words and still be intentional duplicates. A simple unique constraint on those fields would delete real user work.

inkledger uses its local links to avoid stealing an older twin's remote entry. An entry linked to another, older worklog is not adopted merely because it looks identical. Recreating an update has an even stricter rule: never adopt an entry already linked to a different local worklog.

This is why “deduplicate identical worklogs” is not an adequate specification. The system needs both the remote values and the history of the operation.

The tests include a deliberately created twin and assert that its remote ID stays attached to the original worklog: [`a lost answer's replay never takes a twin's entry`](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.test.ts#L386-L400).

## 5. The latest local intention must still win

The values sent in the timed-out request can be older than the values in the editor when replay starts. inkledger keeps those two versions separate.

If replay adopts an entry that landed with an older start or duration, the outbox operation becomes an update and the latest local time is sent to the adopted remote entry. On trackers that update an entry in place, a changed comment is sent too; on other providers it stays only in inkledger. A queued edit does not simply disappear because an older create succeeded.

Newer local edits also supersede older queued edits. A queued edit currently being sent by another process is not dropped: the new edit or delete waits with a conflict instead of silently losing work.

Relevant code: [turning an adopted create into an update](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.ts#L536-L565), [sending changed comments only where updates happen in place](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.ts#L274-L285), [claiming queued edits](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.ts#L589-L623), and the test for [sending the comment changed while the create waited](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.test.ts#L403-L421).

## 6. What this does not prove

This is not exactly-once delivery. HTTP cannot give that guarantee here.

Adoption is a heuristic based on author, time, duration, words, links and creation windows. Two legitimate entries can be ambiguous when a provider exposes little metadata. Some paths therefore refuse to guess: no matching rule should turn “looks similar” into permission to overwrite or delete somebody else's time.

The useful guarantee is narrower and more testable: **the recovery path preserves intent, makes competing replays cooperate, and avoids creating a duplicate when the earlier result can be identified safely.**

## 7. The failure cases are part of the design

The test suite covers the situations that a happy-path demo would miss:

- [a create that timed out after landing is adopted once](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.test.ts#L205-L227);
- [a local fault after the tracker accepted the create links rather than duplicates](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.test.ts#L245-L266);
- [a lost answer is adopted instead of logged twice](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.test.ts#L371-L384);
- [a queued edit being sent by another process waits with a conflict](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.test.ts#L305-L325);
- [a refused newer edit preserves the older queued edit](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.test.ts#L327-L342);
- [a lease whose holder died expires and allows the next write](https://github.com/inkledger/inkledger/blob/v0.1.0/api/sync/timeWrites.test.ts#L361-L369).

The source and tests are in the [inkledger repository](https://github.com/inkledger/inkledger), released under MIT. The case study with the wider architecture is in [`docs/case-study.pdf`](case-study.pdf).

inkledger was built with AI agents (Claude Code), and this article was drafted with AI assistance. The implementation and tests linked above are the source of truth for the behavior described.
