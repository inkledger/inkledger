import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { mailLinks, mails, markdownNotes, type Mail } from "@db/schema";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { MAIL_SOURCES, parseOutlookUrl } from "@contracts/mail";
import { safeExternalUrl } from "@contracts/links";
import { instantSchema } from "@contracts/values";
import { t } from "@contracts/i18n";

/**
 * Pinned mails (contracts/mail.ts): headers and the link back to Outlook, pinned
 * to issues and Markdown notes here; TODOs and post-its point at a mail themselves.
 * The same message is stored once per user (by Message-ID, else by Exchange id).
 */
const idInput = z.number().int().positive();
const noteId = z.string().uuid();
const link = z
  .string()
  .trim()
  .max(4000)
  .transform((s, ctx) => {
    // An Outlook link comes back in its stable form; any other must at least be a safe https link.
    const outlook = parseOutlookUrl(s);
    if (outlook) return outlook.webLink;
    const url = safeExternalUrl(s);
    if (!url || url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: t("server.mails.badLink") });
      return z.NEVER;
    }
    return url.href;
  });
const headers = z.object({
  subject: z.string().trim().max(500),
  fromName: z.string().trim().max(300).nullish(),
  fromAddress: z.string().trim().toLowerCase().max(320).nullish(),
  receivedAt: instantSchema.nullish(),
  webLink: link.nullish(),
  internetMessageId: z.string().trim().min(1).max(998).nullish(),
  exchangeId: z.string().trim().min(1).max(1000).nullish(),
  source: z.enum(MAIL_SOURCES),
});
const target = z.union([z.object({ issueKey: issueKeyInput, connectionId: idInput.optional() }), z.object({ noteId })]);

/** A pinned mail as the page sees it. */
export type MailRow = Pick<Mail, "id" | "subject" | "fromName" | "fromAddress" | "receivedAt" | "webLink" | "internetMessageId" | "source">;
const columns = {
  id: mails.id,
  subject: mails.subject,
  fromName: mails.fromName,
  fromAddress: mails.fromAddress,
  receivedAt: mails.receivedAt,
  webLink: mails.webLink,
  internetMessageId: mails.internetMessageId,
  source: mails.source,
};

async function ownMail(userId: number, id: number): Promise<Mail> {
  const [row] = await getDb().select().from(mails).where(and(eq(mails.id, id), eq(mails.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.mails.notFound") });
  return row;
}

/** The note, the user's and not in the trash. */
async function liveNote(userId: number, id: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: markdownNotes.id })
    .from(markdownNotes)
    .where(and(eq(markdownNotes.id, id), eq(markdownNotes.userId, userId), isNull(markdownNotes.deletedAt)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.notes.notFound") });
}

/** Where a pin goes, its connection checked: the row's target columns. */
async function targetOf(userId: number, to: z.infer<typeof target>): Promise<{ connectionId: number | null; issueKey: string | null; noteId: string | null }> {
  if ("noteId" in to) {
    await liveNote(userId, to.noteId);
    return { connectionId: null, issueKey: null, noteId: to.noteId };
  }
  const conn = await issueConnection(userId, to.issueKey, to.connectionId);
  return { connectionId: conn.id, issueKey: to.issueKey, noteId: null };
}

const targetWhere = (userId: number, mailId: number, to: { connectionId: number | null; issueKey: string | null; noteId: string | null }): SQL | undefined =>
  and(
    eq(mailLinks.userId, userId),
    eq(mailLinks.mailId, mailId),
    to.noteId !== null ? eq(mailLinks.noteId, to.noteId) : and(eq(mailLinks.connectionId, to.connectionId ?? -1), eq(mailLinks.issueKey, to.issueKey ?? "")),
  );

export const mailsRouter = createRouter({
  /**
   * Saves a mail: a new one, or the one already kept with the same Message-ID or
   * Exchange id, completed with what this copy knows (a subject typed by hand
   * stays when the new copy has none).
   */
  save: protectedProcedure.input(headers).mutation(async ({ ctx, input }): Promise<MailRow> => {
    const userId = ctx.user.id;
    const same = [
      input.internetMessageId ? eq(mails.internetMessageId, input.internetMessageId) : undefined,
      input.exchangeId ? eq(mails.exchangeId, input.exchangeId) : undefined,
    ].filter((c): c is SQL => c !== undefined);
    const now = new Date();
    const values = {
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.fromName ? { fromName: input.fromName } : {}),
      ...(input.fromAddress ? { fromAddress: input.fromAddress } : {}),
      ...(input.receivedAt != null ? { receivedAt: new Date(input.receivedAt) } : {}),
      ...(input.webLink ? { webLink: input.webLink } : {}),
      ...(input.internetMessageId ? { internetMessageId: input.internetMessageId } : {}),
      ...(input.exchangeId ? { exchangeId: input.exchangeId } : {}),
    };
    return getDb().transaction(async tx => {
      const [known] = same.length
        ? await tx.select().from(mails).where(and(eq(mails.userId, userId), or(...same))).limit(1).for("update")
        : [];
      if (known) {
        const [row] = await tx.update(mails).set({ ...values, updatedAt: now }).where(eq(mails.id, known.id)).returning(columns);
        return row;
      }
      if (!input.subject && !input.webLink) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.mails.empty") });
      const [row] = await tx
        .insert(mails)
        .values({ userId, subject: "", source: input.source, ...values, createdAt: now, updatedAt: now })
        .returning(columns);
      return row;
    });
  }),

  /** Retitles a mail (its subject is all a pasted link cannot tell). */
  update: protectedProcedure
    .input(z.object({ id: idInput, subject: z.string().trim().min(1, { error: () => t("server.mails.empty") }).max(500) }))
    .mutation(async ({ ctx, input }) => {
      await ownMail(ctx.user.id, input.id);
      const [row] = await getDb().update(mails).set({ subject: input.subject, updatedAt: new Date() }).where(eq(mails.id, input.id)).returning(columns);
      return row;
    }),

  /** Forgets a mail everywhere: its pins go, TODOs about it stay without it. */
  remove: protectedProcedure.input(z.object({ id: idInput })).mutation(async ({ ctx, input }) => {
    await ownMail(ctx.user.id, input.id);
    await getDb().delete(mails).where(eq(mails.id, input.id));
    return { ok: true as const };
  }),

  /** Pins a mail to an issue or a Markdown note (pinning it twice is one pin). */
  pin: protectedProcedure.input(z.object({ mailId: idInput, to: target })).mutation(async ({ ctx, input }) => {
    const userId = ctx.user.id;
    await ownMail(userId, input.mailId);
    const to = await targetOf(userId, input.to);
    await getDb().insert(mailLinks).values({ userId, mailId: input.mailId, ...to }).onConflictDoNothing();
    await getDb().update(mails).set({ updatedAt: new Date() }).where(eq(mails.id, input.mailId));
    return { ok: true as const };
  }),

  unpin: protectedProcedure.input(z.object({ mailId: idInput, to: target })).mutation(async ({ ctx, input }) => {
    const userId = ctx.user.id;
    await ownMail(userId, input.mailId);
    const to = "noteId" in input.to ? { connectionId: null, issueKey: null, noteId: input.to.noteId } : await targetOf(userId, input.to);
    await getDb().delete(mailLinks).where(targetWhere(userId, input.mailId, to));
    return { ok: true as const };
  }),

  /** The mails pinned to an issue, the newest message first. */
  forIssue: protectedProcedure.input(z.object({ issueKey: issueKeyInput, connectionId: idInput.optional() })).query(async ({ ctx, input }): Promise<MailRow[]> => {
    const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
    return getDb()
      .select(columns)
      .from(mailLinks)
      .innerJoin(mails, eq(mails.id, mailLinks.mailId))
      .where(and(eq(mailLinks.userId, ctx.user.id), eq(mailLinks.connectionId, conn.id), eq(mailLinks.issueKey, input.issueKey)))
      .orderBy(sql`${mails.receivedAt} DESC NULLS LAST`, desc(mails.id));
  }),

  /** The mails pinned to a Markdown note. */
  forNote: protectedProcedure.input(z.object({ noteId })).query(async ({ ctx, input }): Promise<MailRow[]> =>
    getDb()
      .select(columns)
      .from(mailLinks)
      .innerJoin(mails, eq(mails.id, mailLinks.mailId))
      .where(and(eq(mailLinks.userId, ctx.user.id), eq(mailLinks.noteId, input.noteId)))
      .orderBy(sql`${mails.receivedAt} DESC NULLS LAST`, desc(mails.id)),
  ),

  /** The mails kept lately (to pin one again elsewhere), by subject or sender. */
  recent: protectedProcedure.input(z.object({ query: z.string().trim().max(200).optional() })).query(async ({ ctx, input }): Promise<MailRow[]> => {
    const q = input.query ? `%${input.query.replace(/[\\%_]/g, c => `\\${c}`)}%` : null;
    return getDb()
      .select(columns)
      .from(mails)
      .where(and(eq(mails.userId, ctx.user.id), q ? or(ilike(mails.subject, q), ilike(mails.fromName, q), ilike(mails.fromAddress, q)) : undefined))
      .orderBy(desc(mails.updatedAt), desc(mails.id))
      .limit(20);
  }),
});
