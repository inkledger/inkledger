// Files in chats (contracts/chat.ts): uploaded by a member while writing, sealed for their row,
// sent with a message, served only to the thread's members. The kind is read from the bytes,
// never taken from the browser: pictures show inline, PDFs and plain text in the viewer, anything
// else only downloads; programs are refused.
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { and, eq, sql } from "drizzle-orm";
import { chatFiles } from "@db/schema";
import { CHAT_FILE_MAX_BYTES, CHAT_THREAD_QUOTA_BYTES, type ChatFileView } from "@contracts/chat";
import { t } from "@contracts/i18n";
import { getDb } from "../queries/connection";
import { xactLockIn } from "../queries/locks";
import { restUser } from "../context";
import { openBytesFor, sealBytesFor } from "../lib/crypto";
import { attachmentHeaders, asSandboxedDownload } from "../attachments";
import { sniffImage } from "../ideaFiles";
import { fits, UPLOADS_PER_MINUTE } from "./limits";
import { memberOf } from "./store";

type App = Hono<{ Bindings: HttpBindings }>;

/** Sealed for its row: bytes moved to another file (or thread) don't open. */
const scopeOf = (threadId: number, id: number) => `chat-file:${threadId}:${id}`;

const startsWith = (b: Uint8Array, ...sig: number[]) => sig.every((x, i) => b[i] === x);

/** Programs and scripts: never kept, whatever their name says. */
function isProgram(b: Uint8Array): boolean {
  return (
    startsWith(b, 0x4d, 0x5a) || // Windows PE (MZ)
    startsWith(b, 0x7f, 0x45, 0x4c, 0x46) || // ELF
    startsWith(b, 0xfe, 0xed, 0xfa, 0xce) ||
    startsWith(b, 0xfe, 0xed, 0xfa, 0xcf) ||
    startsWith(b, 0xce, 0xfa, 0xed, 0xfe) ||
    startsWith(b, 0xcf, 0xfa, 0xed, 0xfe) ||
    startsWith(b, 0xca, 0xfe, 0xba, 0xbe) || // Mach-O, fat binaries (and Java classes)
    startsWith(b, 0x23, 0x21) // #! script
  );
}

/** Text a person reads (UTF-8, no control bytes but tabs and line ends). */
function isText(b: Uint8Array): boolean {
  if (b.length === 0) return false;
  const head = b.subarray(0, 64 * 1024);
  for (const x of head) if (x === 0 || (x < 32 && x !== 9 && x !== 10 && x !== 13)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.length < b.length ? head.subarray(0, lastWhole(head)) : head);
    return true;
  } catch {
    return false;
  }
}

/** Where the last whole UTF-8 character of a cut ends. */
function lastWhole(b: Uint8Array): number {
  let i = b.length;
  while (i > 0 && i > b.length - 4 && (b[i - 1] & 0xc0) === 0x80) i--;
  return i > 0 && b[i - 1] >= 0xc0 ? i - 1 : b.length;
}

/** What a chat file is, by its bytes: null when it can't be kept. */
export function sniffChatFile(b: Uint8Array): string | null {
  if (isProgram(b)) return null;
  const image = sniffImage(b);
  if (image) return image;
  if (startsWith(b, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (startsWith(b, 0x50, 0x4b, 0x03, 0x04)) return "application/zip";
  // Text (logs, CSV, JSON, SQL…) is shown as text, never as the HTML or SVG it may contain.
  if (isText(b)) return "text/plain";
  return "application/octet-stream";
}

/** A picture's size, from its header (no layout shift while it loads); null when unknown. */
export function imageSize(b: Uint8Array, type: string): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w < 100_000 && h < 100_000 ? { width: w, height: h } : null);
  try {
    if (type === "image/png" && b.length >= 24) return ok(dv.getUint32(16), dv.getUint32(20));
    if (type === "image/gif" && b.length >= 10) return ok(dv.getUint16(6, true), dv.getUint16(8, true));
    if (type === "image/webp" && b.length >= 30) {
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (chunk === "VP8X") return ok(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
      if (chunk === "VP8 ") return ok(dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff);
      if (chunk === "VP8L") {
        const bits = dv.getUint32(21, true);
        return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
      return null;
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        const len = dv.getUint16(i + 2);
        // Start of frame (baseline, progressive…), not DHT/JPG/DAC.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(dv.getUint16(i + 7), dv.getUint16(i + 5));
        i += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** A name to read, not to obey: no control characters or path, at most 200. */
export function cleanName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  return [...base].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("").trim().slice(0, 200) || fallback;
}

export type Uploaded = ChatFileView;

/** Keeps a file a member uploads to a thread (not sent yet): its kind read, sealed, within the thread's quota. */
export async function storeChatFile(userId: number, threadId: number, name: string, bytes: Buffer): Promise<Uploaded | { error: string; status: 400 | 413 | 415 }> {
  const clean = cleanName(name, "file");
  if (bytes.length > CHAT_FILE_MAX_BYTES) return { error: t("server.chat.fileTooLarge", { name: clean, mb: CHAT_FILE_MAX_BYTES / 1024 / 1024 }), status: 413 };
  const type = sniffChatFile(bytes);
  if (!type) return { error: t("server.chat.fileType", { name: clean }), status: 415 };
  const size = type.startsWith("image/") ? imageSize(bytes, type) : null;
  const out = await getDb().transaction(async (tx) => {
    // Counted under the thread's lock: uploads at once never pass the quota together.
    await xactLockIn(tx, "chat-files", threadId);
    const [{ total }] = await tx
      .select({ total: sql<number>`coalesce(sum(${chatFiles.size}), 0)::bigint` })
      .from(chatFiles)
      .where(eq(chatFiles.threadId, threadId));
    if (Number(total) + bytes.length > CHAT_THREAD_QUOTA_BYTES) return null;
    // Sealed for its own id: the row first (a placeholder), then its bytes.
    const [row] = await tx
      .insert(chatFiles)
      .values({ threadId, uploaderId: userId, name: clean, contentType: type, size: bytes.length, width: size?.width ?? null, height: size?.height ?? null, data: Buffer.alloc(0) })
      .returning({ id: chatFiles.id });
    await tx.update(chatFiles).set({ data: sealBytesFor(bytes, scopeOf(threadId, row.id)) }).where(eq(chatFiles.id, row.id));
    return row.id;
  });
  if (out === null) return { error: t("server.chat.quota", { mb: CHAT_THREAD_QUOTA_BYTES / 1024 / 1024 }), status: 413 };
  return { id: out, name: clean, contentType: type, size: bytes.length, width: size?.width ?? null, height: size?.height ?? null };
}

/**
 * A chat file, opened, for a member of its thread: sent ones to every member, one not sent yet
 * to its uploader only. Null when the caller may not have it (or it is gone).
 */
export async function chatFileFor(userId: number, id: number): Promise<{ name: string; contentType: string; bytes: Buffer; threadId: number } | null> {
  const [row] = await getDb().select().from(chatFiles).where(eq(chatFiles.id, id)).limit(1);
  if (!row) return null;
  try {
    await memberOf(userId, row.threadId);
  } catch {
    return null;
  }
  if (row.messageId === null && row.uploaderId !== userId) return null;
  return { name: row.name, contentType: row.contentType, bytes: openBytesFor(row.data, scopeOf(row.threadId, row.id)), threadId: row.threadId };
}

/** A file not sent yet, taken back by its uploader. */
export async function dropDraftFile(userId: number, id: number): Promise<boolean> {
  const gone = await getDb()
    .delete(chatFiles)
    .where(and(eq(chatFiles.id, id), eq(chatFiles.uploaderId, userId), sql`${chatFiles.messageId} IS NULL`))
    .returning({ id: chatFiles.id });
  return gone.length > 0;
}

export function registerChatFileRoutes(app: App) {
  /** One file (multipart "file") into a thread, not sent yet: answers what the message will carry. */
  app.post("/api/chat/:threadId/files", async (c) => {
    const threadId = Number(c.req.param("threadId"));
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const notFound = c.json({ error: t("server.chat.notFound") }, 404);
    if (!Number.isSafeInteger(threadId) || threadId <= 0) return notFound;
    try {
      await memberOf(who.user.id, threadId);
    } catch {
      return notFound;
    }
    if (!fits(`upload:${who.user.id}`, UPLOADS_PER_MINUTE, 60_000)) return c.json({ error: t("server.chat.slowDown") }, 429);
    let file: File | null;
    try {
      const got = (await c.req.formData()).get("file");
      file = got instanceof File && got.size > 0 ? got : null;
    } catch {
      return c.json({ error: t("server.attachments.invalidRequest") }, 400);
    }
    if (!file) return c.json({ error: t("server.attachments.noFile") }, 400);
    if (file.size > CHAT_FILE_MAX_BYTES) return c.json({ error: t("server.chat.fileTooLarge", { name: cleanName(file.name, "file"), mb: CHAT_FILE_MAX_BYTES / 1024 / 1024 }) }, 413);
    const out = await storeChatFile(who.user.id, threadId, file.name, Buffer.from(await file.arrayBuffer()));
    if ("error" in out) return c.json({ error: out.error }, out.status);
    return c.json(out);
  });

  /** A file, to the members of its thread only (anyone else: not found); ?download=1 always downloads. */
  app.get("/api/chat/files/:fileId", async (c) => {
    const id = Number(c.req.param("fileId"));
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: t("server.attachments.notFound") }, 404);
    const file = await chatFileFor(who.user.id, id).catch(() => null);
    if (!file) return c.json({ error: t("server.attachments.notFound") }, 404);
    const headers = attachmentHeaders(file.contentType, file.name);
    return new Response(new Uint8Array(file.bytes), { status: 200, headers: c.req.query("download") === "1" ? asSandboxedDownload(headers) : headers });
  });

  /** A file not sent yet, taken back. */
  app.delete("/api/chat/files/:fileId", async (c) => {
    const id = Number(c.req.param("fileId"));
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    if (!Number.isSafeInteger(id) || id <= 0 || !(await dropDraftFile(who.user.id, id))) return c.json({ error: t("server.attachments.notFound") }, 404);
    return c.json({ ok: true });
  });
}
