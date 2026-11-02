// Rows of the user's, by id: the row, or NOT_FOUND (never whether another's
// exists: R-0.8).
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { buckets, issueNotes, mails, todos, type IssueNote, type Mail, type Todo } from "@db/schema";
import { t } from "@contracts/i18n";
import { getDb } from "./connection";

/** A private note of the user (issue_notes). */
export async function ownIssueNote(userId: number, id: number): Promise<IssueNote> {
  const [row] = await getDb()
    .select()
    .from(issueNotes)
    .where(and(eq(issueNotes.id, id), eq(issueNotes.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issueNotes.notFound") });
  return row;
}

/** A pinned mail of the user. */
export async function ownMail(userId: number, id: number): Promise<Mail> {
  const [row] = await getDb().select().from(mails).where(and(eq(mails.id, id), eq(mails.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.mails.notFound") });
  return row;
}

/** A TODO of the user. */
export async function ownTodo(userId: number, id: number): Promise<Todo> {
  const [row] = await getDb()
    .select()
    .from(todos)
    .where(and(eq(todos.id, id), eq(todos.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.todos.notFound") });
  return row;
}

/** A bucket of the user; `message` says why when it isn't (none: the code alone). */
export async function ownBucket(userId: number, id: number, message?: string): Promise<{ id: number }> {
  const [row] = await getDb().select({ id: buckets.id }).from(buckets).where(and(eq(buckets.id, id), eq(buckets.userId, userId))).limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message });
  return row;
}
