import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { mailAddinKeys, mailCopies, mailLinks, mails, markdownNotes, pinboardNotes, pinboards, todos, type Mail, type User } from "@db/schema";
import type { TrpcContext } from "../context";
import { env } from "../lib/env";
import { providerCall } from "../providers/trpc";
import { captureFromGraph, copyInfo, mailCopyColumns, ownMailRow } from "../mail/copies";
import { checkMail } from "../mail/goneCheck";
import { findByMessageId, mailAccount, pollMailLogin, searchMailbox, signOutMail, startMailLogin } from "../mail/microsoft";
import { todosRouter } from "./todos";
import { pinboardRouter } from "./pinboard";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { MAIL_SOURCES, parseOutlookUrl } from "@contracts/mail";
import { safeExternalUrl } from "@contracts/links";
import { boardDisplayName } from "@contracts/pinboard";
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

/** A row in a list: with what is known of its copy (the cards' chips). */
const listed = { ...columns, ...mailCopyColumns };
type ListedMail = MailRow & { copyMode: "body" | "full" | null; copyError: string | null; goneAt: Date | null };

const pick = (m: Mail): MailRow => ({
  id: m.id,
  subject: m.subject,
  fromName: m.fromName,
  fromAddress: m.fromAddress,
  receivedAt: m.receivedAt,
  webLink: m.webLink,
  internetMessageId: m.internetMessageId,
  source: m.source,
});

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

const dayInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Where "pin a mail" puts it: an issue, a note, a new TODO about it, a pinboard. */
const anywhere = z.union([
  target,
  z.object({ todo: z.object({ text: z.string().trim().max(500).optional(), dueOn: dayInput.nullish() }) }),
  // A board of the user's, a new one by its name, or the one in use.
  z.object({ board: z.object({ boardId: z.number().int().positive().optional(), newBoard: z.string().trim().min(1).max(60).optional() }) }),
]);

/** A mail from a file has no link: the mailbox, when signed in, knows it by its Message-ID. */
async function withLink(userId: number, input: z.infer<typeof headers>): Promise<z.infer<typeof headers>> {
  // The add-in's link is built from an id that changes when the mail moves: the mailbox's (immutable) one is better.
  if (!input.internetMessageId || (input.webLink && input.source !== "addin")) return input;
  const found = await findByMessageId(userId, input.internetMessageId).catch(() => null);
  return found ? { ...input, webLink: parseOutlookUrl(found.webLink ?? "")?.webLink ?? found.webLink, exchangeId: input.exchangeId ?? found.exchangeId } : input;
}

/** The add-in's key: shown once, kept as its hash. */
export const addinKeyHash = (key: string) => createHash("sha256").update(key).digest("hex");

/**
 * Saves a mail: a new one, or the one already kept with the same Message-ID or
 * Exchange id, completed with what this copy knows (a subject typed by hand
 * stays when the new copy has none).
 */
async function saveMail(userId: number, given: z.infer<typeof headers>): Promise<MailRow> {
  const input = await withLink(userId, given);
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
}


/** Pins a saved mail where it was asked: a TODO about it, a board, an issue or a note. */
async function pinMailTo(ctx: TrpcContext & { user: User }, mail: MailRow, to: z.infer<typeof anywhere>) {
    if ("todo" in to) {
      const todo = await todosRouter.createCaller(ctx).add({ text: to.todo.text || mail.subject || t("server.mails.noSubjectTodo"), mailId: mail.id, dueOn: to.todo.dueOn ?? null });
      return { mail, todoId: todo.id };
    }
    if ("board" in to) {
      const boards = pinboardRouter.createCaller(ctx);
      const boardId = to.board.newBoard ? (await boards.createBoard({ name: to.board.newBoard })).id : to.board.boardId;
      const r = await boards.pinMail({ mailId: mail.id, boardId });
      return { mail, boardName: r.boardName };
    }
    const where = await targetOf(ctx.user.id, to);
    await getDb().insert(mailLinks).values({ userId: ctx.user.id, mailId: mail.id, ...where }).onConflictDoNothing();
    return { mail };
}

export const mailsRouter = createRouter({
  /** How many copies of my mails are kept, and their size in clear (docs/work/ideas/mail-copies.md R-1.12). */
  copyUsage: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${mailCopies.plainBytes}), 0)::int` })
      .from(mailCopies)
      .where(eq(mailCopies.userId, ctx.user.id));
    // Whether the server keeps copies at all (MAIL_COPIES): the Settings group is absent otherwise (R-0.1).
    return { available: env.mailCopies, count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
  }),

  /** What is known of a mail's copy, never its content (R-1.6, R-1.13). */
  copyInfo: protectedProcedure.input(z.object({ id: idInput })).query(({ ctx, input }) => copyInfo(ctx.user.id, input.id)),

  /** One mail's copy gone; the pin stays (R-1.12). */
  deleteCopy: protectedProcedure.input(z.object({ id: idInput })).mutation(async ({ ctx, input }) => {
    await ownMailRow(ctx.user.id, input.id);
    await getDb().delete(mailCopies).where(and(eq(mailCopies.mailId, input.id), eq(mailCopies.userId, ctx.user.id)));
    return { ok: true as const };
  }),

  /** Ask the mailbox again for a copy that failed (E-1.6 when not signed in). */
  retryCopy: protectedProcedure.input(z.object({ id: idInput })).mutation(async ({ ctx, input }) => {
    const mail = await ownMailRow(ctx.user.id, input.id);
    if (!(await mailAccount(ctx.user.id))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.mails.copy.noGraph") });
    await captureFromGraph(ctx.user.id, mail);
    return copyInfo(ctx.user.id, input.id);
  }),

  /** Is it still in my mailbox? Looked for now (R-1.11); E-1.6 when not signed in. */
  checkGone: protectedProcedure.input(z.object({ id: idInput })).mutation(async ({ ctx, input }) => {
    const mail = await ownMailRow(ctx.user.id, input.id);
    if (!(await mailAccount(ctx.user.id))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.mails.copy.noGraph") });
    if (!mail.internetMessageId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.mails.copy.notInMailbox") });
    const goneAt = await providerCall(() => checkMail(ctx.user.id, { id: mail.id, internetMessageId: mail.internetMessageId!, goneAt: mail.goneAt }, Date.now()));
    return { goneAt };
  }),

  /** Every copy of my mails gone at once; the pins stay (R-1.12). */
  deleteAllCopies: protectedProcedure.mutation(async ({ ctx }) => {
    const gone = await getDb().delete(mailCopies).where(eq(mailCopies.userId, ctx.user.id)).returning({ id: mailCopies.mailId });
    return { count: gone.length };
  }),

  save: protectedProcedure.input(headers).mutation(({ ctx, input }) => saveMail(ctx.user.id, input)),

  /**
   * Saves a mail and pins it in one go, wherever it goes: the picker and the
   * Outlook add-in. A TODO is a new one about the mail (its subject, unless a text is given).
   */
  pinTo: protectedProcedure.input(z.object({ mail: z.union([z.object({ id: idInput }), headers]), to: anywhere })).mutation(async ({ ctx, input }) => {
    // A mail kept already (the picker's "already pinned"), or one to save first.
    const mail: MailRow = "id" in input.mail ? pick(await ownMail(ctx.user.id, input.mail.id)) : await saveMail(ctx.user.id, input.mail);
    const pinned = await pinMailTo(ctx, mail, input.to);
    // Its copy, when the user keeps them: a failure stays on the mail, never on the pin (R-1.6).
    await captureFromGraph(ctx.user.id, await ownMailRow(ctx.user.id, mail.id));
    return pinned;
  }),

  /** The Microsoft sign-in: whether the server can, and who is signed in. */
  account: protectedProcedure.query(async ({ ctx }) => ({
    available: !!env.microsoftClientId || env.mailSimulator,
    account: await mailAccount(ctx.user.id),
  })),
  signInStart: protectedProcedure.mutation(({ ctx }) => providerCall(() => startMailLogin(ctx.user.id))),
  signInPoll: protectedProcedure
    .input(z.object({ flowId: z.string().uuid() }))
    .mutation(({ ctx, input }) => providerCall(() => pollMailLogin(ctx.user.id, input.flowId))),
  signOut: protectedProcedure.mutation(async ({ ctx }) => {
    await signOutMail(ctx.user.id);
    return { ok: true as const };
  }),

  /** The mailbox searched (or the inbox's latest), headers only; null when not signed in. */
  search: protectedProcedure
    .input(z.object({ query: z.string().trim().max(200).optional() }))
    .query(({ ctx, input }) => providerCall(() => searchMailbox(ctx.user.id, input.query))),

  /** The Outlook add-in's key: whether there is one, and when it was last used. */
  addinKey: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await getDb()
      .select({ createdAt: mailAddinKeys.createdAt, lastUsedAt: mailAddinKeys.lastUsedAt })
      .from(mailAddinKeys)
      .where(eq(mailAddinKeys.userId, ctx.user.id))
      .orderBy(desc(mailAddinKeys.id))
      .limit(1);
    return row ?? null;
  }),
  /** A new key for the add-in (the old one stops working): shown this once. */
  newAddinKey: protectedProcedure.mutation(async ({ ctx }) => {
    const key = `ikl_ol_${randomBytes(32).toString("base64url")}`;
    await getDb().transaction(async tx => {
      await tx.delete(mailAddinKeys).where(eq(mailAddinKeys.userId, ctx.user.id));
      await tx.insert(mailAddinKeys).values({ userId: ctx.user.id, keyHash: addinKeyHash(key) });
    });
    return { key };
  }),
  revokeAddinKey: protectedProcedure.mutation(async ({ ctx }) => {
    await getDb().delete(mailAddinKeys).where(eq(mailAddinKeys.userId, ctx.user.id));
    return { ok: true as const };
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
    await captureFromGraph(userId, await ownMailRow(userId, input.mailId));
    return { ok: true as const };
  }),

  unpin: protectedProcedure.input(z.object({ mailId: idInput, to: target })).mutation(async ({ ctx, input }) => {
    const userId = ctx.user.id;
    await ownMail(userId, input.mailId);
    const to = "noteId" in input.to ? { connectionId: null, issueKey: null, noteId: input.to.noteId } : await targetOf(userId, input.to);
    await getDb().delete(mailLinks).where(targetWhere(userId, input.mailId, to));
    return { ok: true as const };
  }),

  /** Where a mail (by Message-ID or Exchange id) is pinned already: the add-in shows it when the mail opens. */
  placesOf: protectedProcedure
    .input(z.object({ internetMessageId: z.string().trim().min(1).max(998).nullish(), exchangeId: z.string().trim().min(1).max(1000).nullish() }))
    .query(async ({ ctx, input }) => {
      const same = [
        input.internetMessageId ? eq(mails.internetMessageId, input.internetMessageId) : undefined,
        input.exchangeId ? eq(mails.exchangeId, input.exchangeId) : undefined,
      ].filter((c): c is SQL => c !== undefined);
      const none = { issues: [] as string[], todos: [] as string[], boards: [] as string[] };
      if (!same.length) return none;
      const db = getDb();
      const [mail] = await db.select({ id: mails.id }).from(mails).where(and(eq(mails.userId, ctx.user.id), or(...same))).limit(1);
      if (!mail) return none;
      const [issues, open, boards] = await Promise.all([
        db.select({ key: mailLinks.issueKey }).from(mailLinks).where(and(eq(mailLinks.mailId, mail.id), eq(mailLinks.userId, ctx.user.id))),
        db.select({ text: todos.text }).from(todos).where(and(eq(todos.mailId, mail.id), eq(todos.userId, ctx.user.id), isNull(todos.doneAt))),
        db
          .select({ name: pinboards.name })
          .from(pinboardNotes)
          .innerJoin(pinboards, eq(pinboards.id, pinboardNotes.boardId))
          .where(and(eq(pinboardNotes.mailId, mail.id), eq(pinboards.userId, ctx.user.id))),
      ]);
      return {
        issues: issues.flatMap(i => (i.key ? [i.key] : [])),
        todos: open.map(o => o.text),
        boards: boards.map(b => boardDisplayName(b.name)),
      };
    }),

  /** The mails pinned to an issue, the newest message first. */
  forIssue: protectedProcedure.input(z.object({ issueKey: issueKeyInput, connectionId: idInput.optional() })).query(async ({ ctx, input }): Promise<ListedMail[]> => {
    const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
    return getDb()
      .select(listed)
      .from(mailLinks)
      .innerJoin(mails, eq(mails.id, mailLinks.mailId))
      .where(and(eq(mailLinks.userId, ctx.user.id), eq(mailLinks.connectionId, conn.id), eq(mailLinks.issueKey, input.issueKey)))
      .orderBy(sql`${mails.receivedAt} DESC NULLS LAST`, desc(mails.id));
  }),

  /** The mails pinned to a Markdown note. */
  forNote: protectedProcedure.input(z.object({ noteId })).query(async ({ ctx, input }): Promise<ListedMail[]> =>
    getDb()
      .select(listed)
      .from(mailLinks)
      .innerJoin(mails, eq(mails.id, mailLinks.mailId))
      .where(and(eq(mailLinks.userId, ctx.user.id), eq(mailLinks.noteId, input.noteId)))
      .orderBy(sql`${mails.receivedAt} DESC NULLS LAST`, desc(mails.id)),
  ),

  /** The mails kept lately (to pin one again elsewhere), by subject or sender. */
  recent: protectedProcedure.input(z.object({ query: z.string().trim().max(200).optional() })).query(async ({ ctx, input }): Promise<ListedMail[]> => {
    const q = input.query ? `%${input.query.replace(/[\\%_]/g, c => `\\${c}`)}%` : null;
    return getDb()
      .select(listed)
      .from(mails)
      .where(and(eq(mails.userId, ctx.user.id), q ? or(ilike(mails.subject, q), ilike(mails.fromName, q), ilike(mails.fromAddress, q)) : undefined))
      .orderBy(desc(mails.updatedAt), desc(mails.id))
      .limit(20);
  }),
});
