# Status: issue chat

## Goal and done criteria
In-app chat between teammates about a tracker issue: 1:1 that can grow, a Chat tab in Notifications,
a Chat section on the issue, Markdown, files, issue/worklog/comment cards, typing and read receipts,
publish to the tracker. Done = the plan's batches 1–5 landed with their tests, full gate green,
targeted e2e, visual review in every look and density.

## Constraints and out of scope
- Only teammates (shared team) with a connection to the same tracker, verified read-only with *their*
  connection (getIssue) when asked in. Access lost later is not re-checked (v1).
- Threads anchor on tracker type + base URL + the issue's remote id (every user keeps their own copy).
- No notification rows for chat (the tab and the bell badge count unread messages).
- Out of scope: presence (live-decisions batch 9), Web Push with no tab open, chats without an issue,
  multi-process event bus.

## Decisions
- Typing is ephemeral: `publishEphemeral` takes no seq, is not kept, goes out without an SSE id
  (a numbered one would make `missedSince` see gaps and force resyncs).
- GDPR: chat tables are shared; `chat_members`/`chat_reactions` are the person's, threads/messages/files
  are `special` with a dedicated `chat.json` export; erasure leaves words nameless (author set null),
  `purgeChat` drops threads nobody is left in and files never sent after a day.
- Message length = 10 000 (tracker comment limit) so "publish to tracker" never fails on length.
- Rate limits in memory: 30 messages/min per person, one typing signal per ~2 s per thread.

## Batches
- [x] 1 Foundations: contracts/chat.ts, schema + 0061_issue_chat.sql, access/store/router, GDPR, audit, authz cases
- [x] 2 Live: chat event, ephemeral typing, rate limits
- [ ] 3 UI core: Chat tab in Notifications, thread view, composer, teammate picker, issue section and button, badges, popups
- [ ] 4 Files and cards: upload/download, paste/drag, lightbox, issue/worklog cards, "Discuss in chat" from a comment
- [ ] 5 Workflow: resolve, reply, edit/delete, reactions, mute/pin/archive, search, permalink, publish to tracker
- [ ] 6 Extras (optional): local-model summary

## Checks
| Command | Scope | Result |
| ------- | ----- | ------ |
| pnpm check | all | green |
| pnpm vitest run api/chat api/events.test.ts | chat behaviour, SSE ephemeral | 33 passed |
| pnpm vitest run api/authz-idor.test.ts api/gdpr | authorization, GDPR | 558 passed |
| pnpm test | all | 4745 passed after audit snapshot update |
| mutation checks | ephemeral id, monotonic read, teammate check | each caught by a test |

## Blockers and next step
None. Next: batch 3 (UI), Tailwind 4 conventions (outline-clear, @m/@l/@xl, tokens in src/index.css).
