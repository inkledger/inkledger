import { z } from "zod";
import { CHAT_BODY_MAX, CHAT_FILES_PER_MESSAGE, CHAT_FILTERS, CHAT_MEMBERS_MAX, CHAT_REACTIONS, CHAT_SEARCH_MIN, CHAT_THREAD_STATES, CHAT_TYPING_EVERY_MS, chatRefs } from "@contracts/chat";
import { createRouter, protectedProcedure } from "../middleware";
import { issueKeyInput } from "../lib/inputs";
import { record } from "../lib/audit";
import { publishEphemeral } from "../lib/userEvents";
import { fits, forget, limit, SEND_PER_MINUTE } from "../chat/limits";
import {
  addMembers,
  candidates,
  edit,
  leave,
  listThreads,
  markRead,
  messages,
  openThread,
  publish,
  react,
  remove,
  search,
  send,
  setPrefs,
  setState,
  threadsForIssue,
  threadView,
  typingTargets,
  unreadCount,
} from "../chat/store";

const id = z.number().int().positive();
const onIssue = { connectionId: id, key: issueKeyInput };
const people = z.array(id).min(1).max(CHAT_MEMBERS_MAX - 1);

/**
 * Chats about an issue between teammates (the Chat tab of Notifications, an issue's Chat
 * section). Everything is the caller's as a member of the thread: anyone else's thread reads
 * as missing (api/chat/store.ts memberOf); asking someone in checks they are a teammate and
 * that the tracker shows them the issue (api/chat/access.ts).
 */
export const chatRouter = createRouter({
  /** Teammates who may be asked into a chat about this issue, and why the others can't. */
  candidates: protectedProcedure.input(z.object(onIssue)).query(({ ctx, input }) => candidates(ctx.user.id, input.connectionId, input.key)),

  /** A chat with these teammates about the issue: the one already there with exactly them, else a new one. */
  open: protectedProcedure.input(z.object({ ...onIssue, userIds: people })).mutation(async ({ ctx, input }) => {
    const out = await openThread(ctx.user.id, { connectionId: input.connectionId, key: input.key, userIds: input.userIds, origin: ctx.clientId });
    if (!out.reused) void record(ctx, "chat.open", { target: { type: "chat_thread", id: out.threadId }, after: { members: input.userIds.length + 1 } });
    return out;
  }),

  /** The caller's chats about one issue. */
  forIssue: protectedProcedure.input(z.object(onIssue)).query(({ ctx, input }) => threadsForIssue(ctx.user.id, input.connectionId, input.key)),

  /** The caller's chats, pinned first then the latest. */
  threads: protectedProcedure
    .input(z.object({ filter: z.enum(CHAT_FILTERS).default("all"), q: z.string().max(200).optional(), before: z.number().int().positive().optional() }))
    .query(({ ctx, input }) => listThreads(ctx.user.id, input)),

  /** One chat: its issue, members and where each has read to. */
  thread: protectedProcedure.input(z.object({ threadId: id })).query(({ ctx, input }) => threadView(ctx.user.id, input.threadId)),

  /** A page of a chat's messages, oldest first. */
  messages: protectedProcedure
    .input(z.object({ threadId: id, before: id.optional(), after: z.number().int().nonnegative().optional(), around: id.optional() }))
    .query(({ ctx, input }) => messages(ctx.user.id, input)),

  /** A message (a retry with the same nonce writes it once). */
  send: protectedProcedure
    .input(
      z.object({
        threadId: id,
        body: z.string().max(CHAT_BODY_MAX),
        refs: chatRefs.default([]),
        fileIds: z.array(id).max(CHAT_FILES_PER_MESSAGE).default([]),
        replyToId: id.optional(),
        clientNonce: z.string().min(8).max(64).regex(/^[\w-]+$/),
      }),
    )
    .mutation(({ ctx, input }) => {
      limit(`send:${ctx.user.id}`, SEND_PER_MINUTE, 60_000);
      // The message ends its writer's typing on the other side: typing again is told at once.
      forget(`typing:${ctx.user.id}:${input.threadId}`);
      return send(ctx.user.id, { ...input, origin: ctx.clientId });
    }),

  /** One's own message, rewritten. */
  edit: protectedProcedure.input(z.object({ messageId: id, body: z.string().max(CHAT_BODY_MAX) })).mutation(({ ctx, input }) => edit(ctx.user.id, input.messageId, input.body, ctx.clientId)),

  /** One's own message, removed (its line stays, marked). */
  remove: protectedProcedure.input(z.object({ messageId: id })).mutation(async ({ ctx, input }) => {
    await remove(ctx.user.id, input.messageId, ctx.clientId);
    void record(ctx, "chat.message.remove", { target: { type: "chat_message", id: input.messageId } });
  }),

  /** A reaction on or off. */
  react: protectedProcedure
    .input(z.object({ messageId: id, emoji: z.enum(CHAT_REACTIONS), on: z.boolean() }))
    .mutation(({ ctx, input }) => react(ctx.user.id, input.messageId, input.emoji, input.on, ctx.clientId)),

  /** Read up to this message (never moves back). */
  markRead: protectedProcedure.input(z.object({ threadId: id, messageId: id })).mutation(({ ctx, input }) => markRead(ctx.user.id, input.threadId, input.messageId, ctx.clientId)),

  /** "Is typing", told to the others now and never kept. */
  typing: protectedProcedure.input(z.object({ threadId: id })).mutation(async ({ ctx, input }) => {
    // Faster than this only repeats what the others already show.
    if (!fits(`typing:${ctx.user.id}:${input.threadId}`, 1, CHAT_TYPING_EVERY_MS - 200)) return;
    for (const userId of await typingTargets(ctx.user.id, input.threadId)) {
      publishEphemeral(userId, { type: "chat", threadId: input.threadId, change: "typing", by: ctx.user.id }, userId === ctx.user.id ? ctx.clientId : undefined);
    }
  }),

  /** More teammates in (each checked as when opening). */
  addMembers: protectedProcedure.input(z.object({ threadId: id, userIds: people })).mutation(async ({ ctx, input }) => {
    await addMembers(ctx.user.id, input.threadId, input.userIds, ctx.clientId);
    void record(ctx, "chat.members.add", { target: { type: "chat_thread", id: input.threadId }, after: { added: input.userIds.length } });
  }),

  /** Out of a chat; the last one out takes it away. */
  leave: protectedProcedure.input(z.object({ threadId: id })).mutation(async ({ ctx, input }) => {
    await leave(ctx.user.id, input.threadId, ctx.clientId);
    void record(ctx, "chat.leave", { target: { type: "chat_thread", id: input.threadId } });
  }),

  /** Resolved, or open again. */
  setState: protectedProcedure.input(z.object({ threadId: id, state: z.enum(CHAT_THREAD_STATES) })).mutation(({ ctx, input }) => setState(ctx.user.id, input.threadId, input.state, ctx.clientId)),

  /** The caller's own choices for a chat. */
  prefs: protectedProcedure
    .input(z.object({ threadId: id, muted: z.boolean().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }))
    .mutation(({ ctx, input }) => setPrefs(ctx.user.id, input.threadId, input, ctx.clientId)),

  /** A message written on the tracker as a comment, by the caller (once per message). */
  publish: protectedProcedure.input(z.object({ messageId: id })).mutation(async ({ ctx, input }) => {
    const out = await publish(ctx.user, input.messageId, ctx.clientId);
    void record(ctx, "chat.publish", { target: { type: "chat_message", id: input.messageId }, after: { issueKey: out.issueKey, connectionId: out.connectionId } });
    return { commentId: out.commentId };
  }),

  /** What the badges count. */
  unreadCount: protectedProcedure.query(({ ctx }) => unreadCount(ctx.user.id)),

  /** Messages with this text in the caller's chats. */
  search: protectedProcedure.input(z.object({ q: z.string().trim().min(CHAT_SEARCH_MIN).max(200) })).query(({ ctx, input }) => search(ctx.user.id, input.q)),
});
