// Copies of pinned mails (docs/work/ideas/mail-copies.md): made only when the
// user chose to keep them, sealed for their own row (R-1.5), never failing the
// pin they come with (R-1.6). From a dropped .eml, from Graph, from the add-in.
import { createHash } from "node:crypto";
import PostalMime from "postal-mime";
import { and, eq, lt, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Context, Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { mailCopies, mailCopyReads, mails, settings } from "@db/schema";
import { mailCopyBodySchema } from "@contracts/mail";
import { openBytesFor } from "../lib/crypto";
import { attachmentHeaders, contentDisposition } from "../attachments";
import { t } from "@contracts/i18n";
import { dateFormat } from "@contracts/i18n/core";
import { MAIL_COPY_MODES, type MailCopyBody, type MailCopyMode } from "@contracts/mail";
import { getDb } from "../queries/connection";
import { restUser } from "../context";
import { env } from "../lib/env";
import { sealBytesFor } from "../lib/crypto";
import { findByMessageId, messageContent } from "./microsoft";

type App = Hono<{ Bindings: HttpBindings }>;
type Ctx = Context<{ Bindings: HttpBindings }>;
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

/** What a mail row says of its copy, for the cards (never its content): mode, error, gone from the mailbox. */
export const mailCopyColumns = {
  copyMode: sql<"body" | "full" | null>`(SELECT ${mailCopies.mode} FROM ${mailCopies} WHERE ${mailCopies.mailId} = ${mails.id})`,
  copyError: mails.copyError,
  goneAt: mails.goneAt,
};

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

/**
 * A whole mail sent for its copy (R-1.6): a dropped .eml as it is, or the add-in's base64
 * (a third bigger) in JSON: one body limit for both, beside attachments'.
 */
export const copyUploadMaxBytes = () => Math.ceil(env.mailCopyMaxMb * 1024 * 1024 * 1.37) + 64 * 1024;

/** How long each read of a copy is remembered (R-1.9, R-1.10). */
const READS_KEPT_MS = 365 * 86_400_000;

/** Reads of copies older than a year, gone; how many. */
export async function purgeMailCopyReads(now = Date.now()): Promise<number> {
  const gone = await getDb().delete(mailCopyReads).where(lt(mailCopyReads.at, new Date(now - READS_KEPT_MS))).returning({ id: mailCopyReads.id });
  return gone.length;
}

/** The view of a copy: only in a sandboxed frame, nothing from outside, never cached (R-1.7). */
const VIEW_HEADERS = {
  "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
};

type Opened = { mode: "body" | "full"; plain: Buffer; subject: string };

/** A copy of the user's in clear, for one of the reading routes; null when there is none. Each read is recorded (R-1.9). */
async function openCopy(userId: number, mailId: number, via: "view" | "eml" | "attachment"): Promise<Opened | null | "locked"> {
  const [row] = await getDb()
    .select({ mode: mailCopies.mode, sealed: mailCopies.sealed, subject: mails.subject })
    .from(mailCopies)
    .innerJoin(mails, eq(mails.id, mailCopies.mailId))
    .where(and(eq(mailCopies.mailId, mailId), eq(mailCopies.userId, userId), eq(mails.userId, userId)));
  if (!row) return null;
  let plain: Buffer;
  try {
    plain = openBytesFor(Buffer.from(row.sealed), `mailcopy:${userId}:${mailId}`);
  } catch {
    return "locked";
  }
  await getDb().insert(mailCopyReads).values({ userId, mailId, via });
  return { mode: row.mode as "body" | "full", plain, subject: row.subject };
}

/** The mail's date as the user reads dates (their language, the server's zone), or as written when unreadable. */
const shownDate = (raw: string | null): string => {
  if (!raw) return "";
  const at = Date.parse(raw);
  return Number.isNaN(at) ? raw : dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(at);
};

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type ViewHeaders = MailCopyBody["headers"];

/** What the frame shows: who and when, then the mail's HTML (its cid: images as data: in full mode), else its text. */
async function viewOf(o: Opened): Promise<{ headers: ViewHeaders } & ({ html: string } | { text: string })> {
  if (o.mode === "body") {
    const body = mailCopyBodySchema.parse(JSON.parse(o.plain.toString("utf8")));
    return body.html ? { headers: body.headers, html: body.html } : { headers: body.headers, text: body.text };
  }
  const parsed = await PostalMime.parse(o.plain);
  const headers: ViewHeaders = {
    from: addressOf(parsed.from),
    to: (parsed.to ?? []).map(addressOf),
    cc: (parsed.cc ?? []).map(addressOf),
    date: parsed.date ?? null,
    subject: parsed.subject ?? "",
  };
  if (!parsed.html) return { headers, text: parsed.text ?? "" };
  const byCid = new Map(
    (parsed.attachments ?? [])
      .filter((a) => a.contentId && /^image\//.test(a.mimeType ?? ""))
      .map((a) => [a.contentId!.replace(/^<|>$/g, ""), `data:${a.mimeType};base64,${Buffer.from(typeof a.content === "string" ? a.content : new Uint8Array(a.content)).toString("base64")}`]),
  );
  return { headers, html: parsed.html.replace(/cid:([^"'\s)]+)/gi, (m, id: string) => byCid.get(id) ?? m) };
}

export function registerCopyRoutes(app: App) {
  /** The copy's reading routes share their checks: a session, the user's own mail with a copy (else 404, R-0.8). */
  const reading = (via: "view" | "eml" | "attachment", answer: (o: Opened, c: Ctx) => Promise<Response> | Response) =>
    async (c: Ctx) => {
      const who = await restUser(c.req.raw);
      if (!("user" in who)) return c.json({ error: who.error }, who.status);
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id <= 0) return c.json({ error: t("server.mails.notFound") }, 404);
      const opened = await openCopy(who.user.id, id, via);
      if (opened === null) return c.json({ error: t("server.mails.notFound") }, 404);
      if (opened === "locked") return c.json({ error: t("server.mails.copy.locked") }, 409);
      return answer(opened, c);
    };

  app.get(
    "/api/mail/:id/view",
    reading("view", async (o) => {
      const v = await viewOf(o);
      const h = v.headers;
      const lines: [string, string][] = [
        [t("server.mails.copy.from"), h.from],
        [t("server.mails.copy.to"), h.to.join(", ")],
        [t("server.mails.copy.cc"), h.cc.join(", ")],
        [t("server.mails.copy.date"), shownDate(h.date)],
      ];
      const kept = lines.filter(([, v]) => v);
      // A text-only mail is shown as preformatted text, on the same page.
      const content = "text" in v ? `<pre style="white-space:pre-wrap;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0">${escapeHtml(v.text)}</pre>` : v.html;
      // The mail's own HTML under a plain header block: its styles stay its own, nothing loads from outside (the CSP).
      const block = `<table style="font:13px system-ui,sans-serif;color:#555;border-collapse:collapse;margin:0 0 12px">${kept
        .map(([k, v]) => `<tr><th style="text-align:left;padding:1px 8px 1px 0;font-weight:600">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
        .join("")}</table><hr style="border:0;border-top:1px solid #ddd;margin:0 0 12px">`;
      // A mail is written for a white page, whatever the app's theme.
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(o.subject)}</title></head><body style="background:#fff;color:#111;margin:12px">${block}${content}</body></html>`;
      return new Response(page, { headers: { ...VIEW_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
    }),
  );

  app.get(
    "/api/mail/:id/eml",
    reading("eml", (o, c) => {
      if (o.mode !== "full") return c.json({ error: t("server.mails.copy.bodyOnly") }, 404);
      return new Response(new Uint8Array(o.plain), {
        headers: {
          "Content-Type": "message/rfc822",
          "Content-Disposition": contentDisposition("attachment", `${o.subject.trim() || "mail"}.eml`),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }),
  );

  app.get(
    "/api/mail/:id/attachment/:n",
    reading("attachment", async (o, c) => {
      if (o.mode !== "full") return c.json({ error: t("server.mails.copy.bodyOnly") }, 404);
      const n = Number(c.req.param("n"));
      const a = Number.isInteger(n) && n >= 0 ? (await PostalMime.parse(o.plain)).attachments?.[n] : undefined;
      if (!a) return c.json({ error: t("server.mails.notFound") }, 404);
      const headers = attachmentHeaders(a.mimeType ?? "application/octet-stream", a.filename ?? "attachment");
      // Always a download from here, sandboxed, never kept by a cache.
      headers.set("Content-Disposition", contentDisposition("attachment", a.filename ?? "attachment"));
      headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
      headers.set("Cache-Control", "private, no-store");
      const bytes = typeof a.content === "string" ? Buffer.from(a.content) : new Uint8Array(a.content);
      return new Response(bytes, { headers });
    }),
  );

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
