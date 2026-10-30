// Pictures in ideas (contracts/ideaFiles.ts): uploaded by their owner, kept
// sealed, served only to them (and through a signed link to an agent, see
// /api/shared). The type is read from the bytes, never taken from the browser.
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ideaFiles, ideas } from "@db/schema";
import { IDEA_FILE_MAX_BYTES, IDEA_FILES_PER_IDEA, IDEA_FILES_QUOTA_BYTES, ideaFileIds, ideaFileMarkdown, replaceIdeaFiles } from "@contracts/ideaFiles";
import { t } from "@contracts/i18n";
import { getDb } from "./queries/connection";
import { restUser } from "./context";
import { openBytesFor, sealBytesFor } from "./lib/crypto";
import { attachmentHeaders } from "./attachments";
import { signShare } from "./lib/shareLinks";
import { getSettings } from "./routers/settings";

type App = Hono<{ Bindings: HttpBindings }>;

/** The picture types an idea takes, by their first bytes. */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** Sealed for its row: bytes moved to another picture don't open. */
const scopeOf = (userId: number, id: number) => `idea-file:${userId}:${id}`;

/** A picture of `userId`'s, opened; null when it isn't theirs (or is gone). */
export async function ownIdeaFile(userId: number, id: number) {
  const [row] = await getDb()
    .select()
    .from(ideaFiles)
    .where(and(eq(ideaFiles.id, id), eq(ideaFiles.userId, userId)))
    .limit(1);
  if (!row) return null;
  return { name: row.name, contentType: row.contentType, bytes: openBytesFor(row.data, scopeOf(userId, id)) };
}

/**
 * An idea's text for someone without a session (an agent): its pictures as signed
 * links, valid `minutes` (the user's share-link setting otherwise), revoked with the rest.
 */
export async function withSharedIdeaFiles(userId: number, markdown: string, origin: string, minutes?: number): Promise<string> {
  const ids = ideaFileIds(markdown);
  if (ids.length === 0) return markdown;
  const own = new Set(
    (await getDb().select({ id: ideaFiles.id }).from(ideaFiles).where(eq(ideaFiles.userId, userId))).map((r) => r.id).filter((id) => ids.includes(id))
  );
  const prefs = await getSettings(userId);
  const now = Date.now();
  const exp = now + (minutes ?? prefs.shareLinkMinutes) * 60_000;
  return replaceIdeaFiles(markdown, (id) =>
    own.has(id) ? `${origin}/api/shared/${signShare({ u: userId, c: 0, a: String(id), f: "idea-file", iat: now, exp, g: prefs.shareLinkGeneration })}` : null
  );
}

export function registerIdeaFileRoutes(app: App) {
  /** One picture (multipart "file") into an idea: answers the Markdown that shows it. */
  app.post("/api/ideas/:id/files", async (c) => {
    const ideaId = Number(c.req.param("id"));
    if (!Number.isSafeInteger(ideaId) || ideaId <= 0) return c.json({ error: t("server.ideas.notFound") }, 404);
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const userId = who.user.id;
    const db = getDb();
    const [idea] = await db
      .select({ id: ideas.id })
      .from(ideas)
      .where(and(eq(ideas.id, ideaId), eq(ideas.userId, userId), isNull(ideas.deletedAt)))
      .limit(1);
    if (!idea) return c.json({ error: t("server.ideas.notFound") }, 404);
    let file: File | null = null;
    try {
      const got = (await c.req.formData()).get("file");
      file = got instanceof File && got.size > 0 ? got : null;
    } catch {
      return c.json({ error: t("server.attachments.invalidRequest") }, 400);
    }
    if (!file) return c.json({ error: t("server.attachments.noFile") }, 400);
    if (file.size > IDEA_FILE_MAX_BYTES) return c.json({ error: t("server.ideas.fileTooLarge", { mb: IDEA_FILE_MAX_BYTES / 1024 / 1024 }) }, 413);
    const bytes = Buffer.from(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type) return c.json({ error: t("server.ideas.fileNotImage") }, 415);
    const [{ count, total }] = await db
      .select({
        count: sql<number>`count(*) FILTER (WHERE ${ideaFiles.ideaId} = ${ideaId})::int`,
        total: sql<number>`coalesce(sum(${ideaFiles.size}), 0)::bigint`,
      })
      .from(ideaFiles)
      .where(eq(ideaFiles.userId, userId));
    if (count >= IDEA_FILES_PER_IDEA) return c.json({ error: t("server.ideas.tooManyFiles", { count: IDEA_FILES_PER_IDEA }) }, 400);
    if (Number(total) + bytes.length > IDEA_FILES_QUOTA_BYTES) return c.json({ error: t("server.ideas.filesQuota", { mb: IDEA_FILES_QUOTA_BYTES / 1024 / 1024 }) }, 400);
    // A name to read, not to obey: no control characters, at most 200.
    const name = [...(file.name || "image")].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("").slice(0, 200) || "image";
    const id = await db.transaction(async (tx) => {
      // Sealed for its own id: the row first (a placeholder), then its bytes.
      const [row] = await tx
        .insert(ideaFiles)
        .values({ userId, ideaId, name, contentType: type, size: bytes.length, data: Buffer.alloc(0) })
        .returning({ id: ideaFiles.id });
      await tx.update(ideaFiles).set({ data: sealBytesFor(bytes, scopeOf(userId, row.id)) }).where(eq(ideaFiles.id, row.id));
      return row.id;
    });
    return c.json({ id, name, markdown: ideaFileMarkdown(id, name) });
  });

  /** A picture, to its owner only (anyone else: not found). */
  app.get("/api/ideas/files/:fileId", async (c) => {
    const id = Number(c.req.param("fileId"));
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: t("server.attachments.notFound") }, 404);
    const file = await ownIdeaFile(who.user.id, id).catch(() => null);
    if (!file) return c.json({ error: t("server.attachments.notFound") }, 404);
    return new Response(new Uint8Array(file.bytes), { status: 200, headers: attachmentHeaders(file.contentType, file.name) });
  });
}
