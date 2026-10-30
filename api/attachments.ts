import { discardBody } from "./providers/core/http";
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { connections, issues, users, type Connection } from "@db/schema";
import { getDb } from "./queries/connection";
import { restUser } from "./context";
import { verifyShare } from "./lib/shareLinks";
import { createRateLimiter } from "./lib/security";
import { clientIp } from "./lib/session";
import { getSettings } from "./routers/settings";
import {
  fetchAttachmentMeta,
  fetchFromSite,
  ISSUE_KEY_RE,
  isNetworkError,
  JiraApiError,
  uploadAttachments,
} from "./jira/client";
import { t } from "@contracts/i18n";
import { connOf, contextFor, jiraContextFor, jiraCredentials, ownConnection } from "./providers/connections";
import { fetchGitHubAttachment } from "./providers/github/attachments";

type App = Hono<{ Bindings: HttpBindings }>;

/** Project icons rarely change: keep them in memory for a few hours. */
const ICON_TTL_MS = 6 * 3600 * 1000;
/** Misses (no icon, stock avatar, unsupported format) are retried sooner. */
const ICON_MISS_TTL_MS = 10 * 60 * 1000;
const ICON_CACHE_MAX = 200;
type IconEntry = { at: number } & (
  | { body: ArrayBuffer; type: string }
  | { body: null; status: 404 | 415; error: string }
);
const projectIcons = new Map<string, IconEntry>();

function cacheIcon(key: string, entry: IconEntry) {
  // Map keeps insertion order: re-inserting makes it the newest, evict from the front.
  projectIcons.delete(key);
  projectIcons.set(key, entry);
  for (const oldest of projectIcons.keys()) {
    if (projectIcons.size <= ICON_CACHE_MAX) break;
    projectIcons.delete(oldest);
  }
}

function isFresh(entry: IconEntry): boolean {
  return Date.now() - entry.at <= (entry.body ? ICON_TTL_MS : ICON_MISS_TTL_MS);
}

/** Jira's stock project avatar (generic, off-palette): treated as "no icon". */
function isStockAvatar(type: string, body: ArrayBuffer): boolean {
  if (type !== "image/svg+xml") return false;
  return /<svg[^>]*\bid="Default"/.test(new TextDecoder().decode(body.slice(0, 512)));
}

/** Upload limits for POST /api/issues/:key/attachments */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 10;

/** Raster images are safe to show inline; everything else (incl. SVG) downloads. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
/**
 * Also previewed in the app's viewer (same-origin iframe). A PDF can't be
 * sandboxed (the browser's PDF viewer refuses to run), so it gets a CSP that
 * still forbids any script or fetch; plain text is shown as text, sandboxed.
 */
const PREVIEW_TYPES = new Map<string, string>([
  ["application/pdf", "default-src 'none'; object-src 'self'; frame-ancestors 'self'"],
  ["text/plain", "sandbox; default-src 'none'; frame-ancestors 'self'"],
]);
const SANDBOXED = "sandbox; default-src 'none'";

/** Headers of an attachment response: inline only for the known-safe types. */
export function attachmentHeaders(mimeType: string, filename: string): Headers {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  const preview = PREVIEW_TYPES.get(type);
  const inline = INLINE_TYPES.has(type) || preview !== undefined;
  return new Headers({
    "Content-Type": !inline
      ? "application/octet-stream"
      : type === "text/plain"
        ? "text/plain; charset=utf-8"
        : type,
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", filename),
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": preview ?? SANDBOXED,
  });
}

export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function jiraErrorResponse(e: unknown): { status: 401 | 404 | 502 | 504; message: string } {
  if (e instanceof TRPCError && e.code === "UNAUTHORIZED") return { status: 401, message: e.message };
  if (e instanceof JiraApiError) {
    if (e.status === 401) return { status: 401, message: t("server.attachments.tokenExpired") };
    // Reads: a forbidden attachment is as good as missing (no existence leak).
    if (e.status === 404 || e.status === 403) return { status: 404, message: t("server.attachments.notFound") };
    return { status: 502, message: t("server.attachments.jiraError", { status: e.status }) };
  }
  if (isNetworkError(e)) return { status: 504, message: t("server.attachments.jiraUnreachable") };
  console.error(e);
  return { status: 502, message: t("server.attachments.jiraContactFailed") };
}

/**
 * Upload errors: a 403 is a refusal to write (read-only guard, no attach
 * permission), not a missing attachment; a 404 is the issue.
 */
export function uploadErrorResponse(e: unknown): { status: 401 | 403 | 404 | 502 | 504; message: string } {
  if (e instanceof JiraApiError && e.status === 403) {
    return {
      status: 403,
      message: /sola lettura|read-only/i.test(e.message)
        ? e.message
        : t("server.attachments.attachNotAllowed"),
    };
  }
  if (e instanceof JiraApiError && e.status === 404) {
    return { status: 404, message: t("server.attachments.issueNotFound") };
  }
  return jiraErrorResponse(e);
}

/** An attachment (or its thumbnail) streamed from its Jira site; null when it has no such content. */
async function streamAttachment(creds: Parameters<typeof fetchAttachmentMeta>[0], id: string, kind: "content" | "thumbnail"): Promise<Response | null> {
  const meta = await fetchAttachmentMeta(creds, id);
  const url = kind === "thumbnail" ? meta.thumbnail : meta.content;
  if (!url) return null;
  const res = await fetchFromSite(creds, url);
  const type = kind === "thumbnail" ? (res.headers.get("content-type") ?? "image/png") : (meta.mimeType ?? "application/octet-stream");
  const headers = attachmentHeaders(type, meta.filename);
  // fetch decompresses encoded bodies: the upstream length would be wrong.
  const length = res.headers.get("content-length");
  if (length && !res.headers.get("content-encoding")) headers.set("Content-Length", length);
  return new Response(res.body, { status: 200, headers });
}

/** A file pasted into a GitHub issue, as a download (docs/work/ideas/issue-copy.md R-6.9). */
async function githubFile(conn: Connection, key: string, url: string): Promise<Response> {
  const cred = await connOf(conn).credential();
  const token = cred.kind === "oauth" ? cred.accessToken : cred.kind === "token" ? cred.token : "";
  const res = await fetchGitHubAttachment({ apiBase: conn.baseUrl, token }, key, url);
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "file");
  const headers = attachmentHeaders(res.headers.get("content-type") ?? "application/octet-stream", name);
  return new Response(res.body, { status: 200, headers });
}

/** Shared links: a few a minute per address is plenty for an agent reading one issue. */
const sharedLimiter = createRateLimiter(120, 60_000);

/** Any refused shared link: nothing said about why (no oracle). */
const notShared = () => new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });

export function registerAttachmentRoutes(app: App) {
  /**
   * An attachment through a link copied for an agent (docs/work/ideas/issue-copy.md):
   * the signed token is the only credential; always a download, never cached.
   */
  app.get("/api/shared/:token", async (c) => {
    if (sharedLimiter.hit(clientIp(c.req.raw, c.env?.incoming?.socket?.remoteAddress)) > 0) return new Response(null, { status: 429 });
    const grant = verifyShare(c.req.param("token"), Date.now());
    if (!grant) return notShared();
    try {
      const [user] = await getDb().select().from(users).where(eq(users.id, grant.u)).limit(1);
      if (!user || (await getSettings(user.id)).shareLinkGeneration !== grant.g) return notShared();
      const conn = await ownConnection(user.id, grant.c).catch(() => null);
      if (!conn) return notShared();
      const res =
        conn.type === "jira"
          ? await streamAttachment(contextFor(user, conn).creds, grant.a, "content")
          : conn.type === "github" && grant.k
            ? await githubFile(conn, grant.k, grant.a)
            : null;
      if (!res) return notShared();
      const headers = new Headers(res.headers);
      headers.set("Content-Disposition", (headers.get("Content-Disposition") ?? "attachment").replace(/^inline/, "attachment"));
      headers.set("Content-Security-Policy", SANDBOXED);
      headers.set("Cache-Control", "private, no-store");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(res.body, { status: 200, headers });
    } catch {
      return notShared();
    }
  });

  /** Stream an attachment (or its thumbnail) through the server with the user's credentials. */
  app.get("/api/attachments/:id/:kind{content|thumbnail}", async (c) => {
    const id = c.req.param("id");
    const kind = c.req.param("kind") as "content" | "thumbnail";
    if (!/^\d+$/.test(id)) return c.json({ error: t("server.attachments.invalidId") }, 400);
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const { user } = who;
    try {
      // The connection the attachment is on (?c=), else the primary one.
      const conn = Number(c.req.query("c"));
      const creds = Number.isInteger(conn) && conn > 0 ? contextFor(user, await ownConnection(user.id, conn)).creds : await jiraCredentials(user);
      const streamed = await streamAttachment(creds, id, kind);
      return streamed ?? c.json({ error: t("server.attachments.previewUnavailable") }, 404);
    } catch (e) {
      const { status, message } = jiraErrorResponse(e);
      return c.json({ error: message }, status);
    }
  });

  /** The signed-in user's Jira avatar (Jira serves it only to authenticated clients). */
  app.get("/api/me/avatar", async (c) => {
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const { user } = who;
    if (!user.avatarUrl) return c.json({ error: t("server.attachments.noAvatar") }, 404);
    try {
      // The avatar is served by the site it lives on: the connection on that site.
      const site = (await getDb().select().from(connections).where(and(eq(connections.userId, user.id), isNull(connections.archivedAt)))).find(
        (conn) => conn.type === "jira" && user.avatarUrl!.startsWith(conn.baseUrl.replace(/\/+$/, "")),
      );
      if (!site) return c.json({ error: t("server.attachments.noAvatar") }, 404);
      const res = await fetchFromSite(contextFor(user, site).creds, user.avatarUrl);
      const type = res.headers.get("content-type") ?? "image/png";
      if (!INLINE_TYPES.has(type.split(";")[0].trim())) {
        return c.json({ error: t("server.attachments.avatarFormat") }, 415);
      }
      return new Response(res.body, {
        headers: {
          "Content-Type": type,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
        },
      });
    } catch (e) {
      const { status, message } = jiraErrorResponse(e);
      return c.json({ error: message }, status);
    }
  });

  /**
   * Jira project icon, proxied (Jira serves it only to authenticated users).
   * SVG is fine here: it is only ever used as <img>, and sandboxed by CSP.
   */
  // A project with no icon of its own is not an error: 204 (the initials stay), never a
  // failed request in the console; kept a while so it isn't asked again on every page.
  const noIcon = () => new Response(null, { status: 204, headers: { "Cache-Control": "private, max-age=3600" } });
  app.get("/api/projects/:key/avatar", async (c) => {
    const key = c.req.param("key");
    if (!/^[A-Z][A-Z0-9_]{0,31}$/i.test(key)) return c.json({ error: t("server.attachments.invalidProject") }, 400);
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const { user } = who;
    const cacheKey = `${user.id}:${c.req.query("c") ?? ""}:${key.toUpperCase()}`;
    let hit = projectIcons.get(cacheKey);
    if (!hit || !isFresh(hit)) {
      const [row] = await getDb()
        .select({ url: issues.projectAvatarUrl, connectionId: issues.connectionId })
        .from(issues)
        .where(
          and(
            eq(issues.userId, user.id),
            eq(issues.projectKey, key.toUpperCase()),
            isNotNull(issues.projectAvatarUrl),
            // A project key may be on two sites: ?c= says which.
            ...(Number(c.req.query("c")) > 0 ? [eq(issues.connectionId, Number(c.req.query("c")))] : []),
          ),
        )
        .limit(1);
      if (!row?.url) return noIcon();
      try {
        const res = await fetchFromSite(contextFor(user, await ownConnection(user.id, row.connectionId)).creds, row.url);
        const type = (res.headers.get("content-type") ?? "image/png").split(";")[0].trim();
        if (!INLINE_TYPES.has(type) && type !== "image/svg+xml") {
          await discardBody(res);
          hit = { body: null, status: 415, error: t("server.attachments.iconFormat"), at: Date.now() };
        } else {
          const body = await res.arrayBuffer();
          hit = isStockAvatar(type, body)
            ? { body: null, status: 404, error: t("server.attachments.defaultIcon"), at: Date.now() }
            : { body, type, at: Date.now() };
        }
        cacheIcon(cacheKey, hit);
      } catch (e) {
        const { status, message } = jiraErrorResponse(e);
        if (status === 404) {
          cacheIcon(cacheKey, { body: null, status, error: message, at: Date.now() });
          return noIcon();
        }
        return c.json({ error: message }, status);
      }
    }
    if (!hit.body) return hit.status === 404 ? noIcon() : c.json({ error: hit.error }, hit.status);
    return new Response(hit.body, {
      headers: {
        "Content-Type": hit.type,
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  });

  /** Upload one or more files (multipart field "file") to a Jira issue. */
  app.post("/api/issues/:key/attachments", async (c) => {
    const key = c.req.param("key");
    if (!ISSUE_KEY_RE.test(key)) return c.json({ error: t("server.issues.invalidKey") }, 400);
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const { user } = who;
    let files: File[];
    try {
      const form = await c.req.formData();
      files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    } catch {
      return c.json({ error: t("server.attachments.invalidRequest") }, 400);
    }
    if (files.length === 0) return c.json({ error: t("server.attachments.noFile") }, 400);
    if (files.length > UPLOAD_MAX_FILES) return c.json({ error: t("server.attachments.maxFiles", { count: UPLOAD_MAX_FILES }) }, 400);
    try {
      const conn = Number(c.req.query("c"));
      const { creds } = await jiraContextFor(user, key, Number.isInteger(conn) && conn > 0 ? conn : undefined);
      const saved = await uploadAttachments(creds, key, files);
      return c.json({ uploaded: saved.map((a) => ({ id: a.id, filename: a.filename })) });
    } catch (e) {
      const { status, message } = uploadErrorResponse(e);
      return c.json({ error: message }, status);
    }
  });
}
