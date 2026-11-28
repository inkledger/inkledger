// The API's checks of what a chat message carries (contracts/chat.ts): kept apart, so the page's
// first load never carries zod for them.
import { z } from "zod";
import { CHAT_REFS_MAX, type ChatRef } from "./chat";

/** An issue in a message: a snapshot of what its sender saw (the reader may not have it imported). */
export const chatIssueRef = z.object({
  kind: z.literal("issue"),
  key: z.string().min(1).max(100),
  title: z.string().max(500),
  status: z.string().max(200),
  category: z.string().max(40),
});
/** A worklog its author chose to show: date, time and words, nothing else of theirs. */
export const chatWorklogRef = z.object({
  kind: z.literal("worklog"),
  key: z.string().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seconds: z.number().int().min(0).max(7 * 24 * 3600),
  comment: z.string().max(2000),
});
/** A tracker comment quoted into the chat ("Discuss in chat"). */
export const chatCommentRef = z.object({
  kind: z.literal("comment"),
  key: z.string().min(1).max(100),
  commentId: z.string().min(1).max(200),
  author: z.string().max(200),
  created: z.string().max(40),
  excerpt: z.string().max(2000),
});
export const chatRef = z.discriminatedUnion("kind", [chatIssueRef, chatWorklogRef, chatCommentRef]);
export const chatRefs = z.array(chatRef).max(CHAT_REFS_MAX);

// The schema and the type say the same thing (a change to one that the other misses fails to compile).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const refsAgree: Same<z.infer<typeof chatRef>, ChatRef> = true;

