// Chat housekeeping, with the server's other purges (api/boot.ts): files uploaded and never sent,
// and chats nobody is left in (their last member's account was erased).
import { and, isNull, lt, sql } from "drizzle-orm";
import { chatFiles, chatMembers, chatThreads } from "@db/schema";
import { CHAT_DRAFT_FILE_TTL_MS } from "@contracts/chat";
import { getDb } from "../queries/connection";

export async function purgeChat(now = Date.now()): Promise<{ drafts: number; threads: number }> {
  const db = getDb();
  const drafts = await db
    .delete(chatFiles)
    .where(and(isNull(chatFiles.messageId), lt(chatFiles.createdAt, new Date(now - CHAT_DRAFT_FILE_TTL_MS))))
    .returning({ id: chatFiles.id });
  const threads = await db
    .delete(chatThreads)
    .where(sql`NOT EXISTS (SELECT 1 FROM ${chatMembers} m WHERE m.thread_id = ${chatThreads.id} AND m.left_at IS NULL)`)
    .returning({ id: chatThreads.id });
  return { drafts: drafts.length, threads: threads.length };
}
