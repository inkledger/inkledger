// Copies of pinned mails (docs/work/ideas/mail-copies.md): made only when the
// user chose to keep them, sealed for their own row (R-1.5), never failing the
// pin they come with (R-1.6). From a dropped .eml, from Graph, from the add-in.
import { createHash } from "node:crypto";
import PostalMime from "postal-mime";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { mailCopies, mails, settings } from "@db/schema";
import { t } from "@contracts/i18n";
import { MAIL_COPY_MODES, type MailCopyBody, type MailCopyMode } from "@contracts/mail";
import { getDb } from "../queries/connection";
import { restUser } from "../context";
import { env } from "../lib/env";
import { sealBytesFor } from "../lib/crypto";
import { findByMessageId, messageContent } from "./microsoft";

type App = Hono<{ Bindings: HttpBindings }>;
export type CopySource = "addin" | "graph" | "eml";
export type CopyAttachment = { name: string; type: string; size: number };

/** Why a copy wasn't made: said to the user (E-1.2, E-1.3, E-1.5). */
export class CopyError extends Error {
  readonly kind: "off" | "tooLarge" | "badEml";
  constructor(kind: "off" | "tooLarge" | "badEml", message: string) {
    super(message);
    this.kind = kind;
  }
}

/** A text part derived from HTML when the mail has none (edge cases): tags out, at most 200 KB. */
const TEXT_FROM_HTML_MAX = 200 * 1024;
const textOf = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .slice(0, TEXT_FROM_HTML_MAX);

const addressOf = (a: { name?: string; address?: string } | undefined): string =>
  a?.address ? (a.name ? `${a.name} <${a.address}>` : a.address) : (a?.name ?? "");

/** The user's choice, unless the server keeps no copies at all (R-1.1). */
export async function copyMode(userId: number): Promise<MailCopyMode> {
  if (!env.mailCopies) return "off";
  const [row] = await getDb().select({ mode: settings.mailCopies }).from(settings).where(eq(settings.userId, userId));
  const mode = row?.mode as MailCopyMode | undefined;
  return mode && MAIL_COPY_MODES.includes(mode) ? mode : "off";
}

/** Off for everyone (the server's switch), or off by the user's own choice. */
const offMessage = () => (env.mailCopies ? t("server.mails.copy.userOff") : t("server.mails.copy.off"));

const maxBytes = () => Math.floor(env.mailCopyMaxMb * 1024 * 1024);

/**
 * Keeps `raw` (a whole message, MIME) as the copy of mail `mailId`: in body mode its
 * headers, text, HTML and attachments' names (R-1.3); in full mode the raw bytes (R-1.4).
 * Replaced only when it changed. Throws CopyError when it may not or can't be kept.
 */
export async function keepCopy(userId: number, mailId: number, raw: Buffer, source: CopySource): Promise<{ mode: "body" | "full"; bytes: number }> {
  const mode = await copyMode(userId);
  if (mode === "off") throw new CopyError("off", offMessage());
  if (raw.length > maxBytes()) throw new CopyError("tooLarge", t("server.mails.copy.tooLarge", { mb: env.mailCopyMaxMb }));
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    parsed = await PostalMime.parse(raw);
  } catch {
    throw new CopyError("badEml", t("server.mails.copy.badEml"));
  }
  if (!parsed.headers?.length) throw new CopyError("badEml", t("server.mails.copy.badEml"));
  const attachments: CopyAttachment[] = (parsed.attachments ?? []).map((a) => ({
    name: a.filename ?? "attachment",
    type: a.mimeType ?? "application/octet-stream",
    size: typeof a.content === "string" ? Buffer.byteLength(a.content) : a.content.byteLength,
  }));
  let plain: Buffer;
  if (mode === "full") plain = raw;
  else {
    const body: MailCopyBody = {
      v: 1,
      headers: {
        from: addressOf(parsed.from),
        to: (parsed.to ?? []).map(addressOf),
        cc: (parsed.cc ?? []).map(addressOf),
        date: parsed.date ?? null,
        subject: parsed.subject ?? "",
      },
      text: parsed.text ?? (parsed.html ? textOf(parsed.html) : ""),
      html: parsed.html ?? null,
      attachments,
    };
    plain = Buffer.from(JSON.stringify(body), "utf8");
  }
  const sha = createHash("sha256").update(plain).digest("hex");
  const db = getDb();
  const [known] = await db.select({ sha: mailCopies.plainSha256 }).from(mailCopies).where(eq(mailCopies.mailId, mailId));
  if (known?.sha !== sha) {
    const row = {
      userId,
      mode,
      sealed: sealBytesFor(plain, `mailcopy:${userId}:${mailId}`),
      plainSha256: sha,
      plainBytes: plain.length,
      attachments: JSON.stringify(attachments),
      source,
      capturedAt: new Date(),
    };
    await db.insert(mailCopies).values({ mailId, ...row }).onConflictDoUpdate({ target: mailCopies.mailId, set: row });
  }
  await db.update(mails).set({ copyError: null }).where(eq(mails.id, mailId));
  return { mode, bytes: plain.length };
}

/**
 * The copy from the mailbox (Graph), when copies are on and the user is signed in:
 * never throws; a failure is kept on the mail for the user to see and retry (R-1.6).
 */
export async function captureFromGraph(userId: number, mail: { id: number; internetMessageId: string | null; exchangeId: string | null }): Promise<void> {
  if ((await copyMode(userId)) === "off") return;
  const fail = (message: string) => getDb().update(mails).set({ copyError: message }).where(eq(mails.id, mail.id));
  try {
    const id = mail.exchangeId ?? (mail.internetMessageId ? (await findByMessageId(userId, mail.internetMessageId))?.exchangeId : null);
    if (!id) return void (await fail(t("server.mails.copy.notInMailbox")));
    const raw = await messageContent(userId, id);
    if (!raw) return; // not signed in: a file or the add-in may still bring it
    await keepCopy(userId, mail.id, raw, "graph");
  } catch (e) {
    await fail(e instanceof CopyError ? e.message : t("server.mails.copy.graphFailed"));
  }
}

/** A mail of the user's, or NOT_FOUND (never whether it exists: R-0.8). */
export async function ownMailRow(userId: number, mailId: number) {
  const [row] = await getDb()
    .select({ id: mails.id, internetMessageId: mails.internetMessageId, exchangeId: mails.exchangeId, goneAt: mails.goneAt, copyError: mails.copyError })
    .from(mails)
    .where(and(eq(mails.id, mailId), eq(mails.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.mails.notFound") });
  return row;
}

/** What is known of a mail's copy (never its content). */
export async function copyInfo(userId: number, mailId: number) {
  const mail = await ownMailRow(userId, mailId);
  const [c] = await getDb()
    .select({ mode: mailCopies.mode, bytes: mailCopies.plainBytes, capturedAt: mailCopies.capturedAt, attachments: mailCopies.attachments })
    .from(mailCopies)
    .where(eq(mailCopies.mailId, mailId));
  const list = c ? (JSON.parse(c.attachments) as CopyAttachment[]) : [];
  return {
    copy: c ? { mode: c.mode as "body" | "full", bytes: c.bytes, capturedAt: c.capturedAt, attachments: list.map((a, index) => ({ index, ...a })) } : null,
    goneAt: mail.goneAt,
    copyError: mail.copyError,
  };
}

/** A whole .eml dropped on a mail already pinned (R-1.6): its own body limit, beside attachments'. */
export const copyUploadMaxBytes = () => Math.ceil(env.mailCopyMaxMb * 1024 * 1024) + 64 * 1024;

export function registerCopyRoutes(app: App) {
  app.post("/api/mail/:id/copy", async (c) => {
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: t("server.mails.notFound") }, 404);
    try {
      await ownMailRow(who.user.id, id);
    } catch {
      return c.json({ error: t("server.mails.notFound") }, 404);
    }
    if ((await copyMode(who.user.id)) === "off") return c.json({ error: offMessage() }, 403);
    const raw = Buffer.from(await c.req.arrayBuffer());
    try {
      return c.json(await keepCopy(who.user.id, id, raw, "eml"));
    } catch (e) {
      if (!(e instanceof CopyError)) throw e;
      // Kept on the mail as a capture from Graph would be (R-1.6): the card says it.
      if (e.kind !== "off") await getDb().update(mails).set({ copyError: e.message }).where(eq(mails.id, id));
      return c.json({ error: e.message }, e.kind === "off" ? 403 : e.kind === "tooLarge" ? 413 : 400);
    }
  });
}
