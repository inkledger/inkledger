// First import: settles the system time zone before any Date is created.
import "./lib/tz";
import { localeMiddleware } from "./lib/i18n";
import { createServer as createHttpsServer } from "node:https";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { compress } from "hono/compress";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { closeDb, initDb, pingDb, purgeExpiredSessions } from "./queries/connection";
import { purgeDismissedNotifications } from "./routers/notifications";
import { purgeIdleModuleFiles } from "./modules/files";
import { purgeTrash } from "./queries/trash";
import { registerAttachmentRoutes, UPLOAD_MAX_BYTES } from "./attachments";
import { registerIdeaFileRoutes } from "./ideaFiles";
import { IDEA_FILE_MAX_BYTES } from "@contracts/ideaFiles";
import { registerDownloadRoutes } from "./downloads";
import { registerModuleRoutes } from "./modules/routes";
import { ACTIVATION_DEFAULTS, renewActivations } from "./modules/activation";
import { ACTIVATION_KEYS } from "./modules/keys";
import { validLicenses } from "./modules/registry";
import { purgeWebhookDeliveries, registerHookRoutes } from "./hooks";
import { outlookFrames, registerOutlookRoutes } from "./mail/addin";
import { copyUploadMaxBytes, purgeMailCopyReads, purgeOrphanMailCopies, registerCopyRoutes } from "./mail/copies";
import { startGoneCheck } from "./mail/goneCheck";
import { flushEgress, installEgressLog } from "./lib/egress";
import { registerStoreRoutes } from "./store/routes";
import { registerAuditRoutes } from "./auditExport";
import { flushAudit, purgeAudit } from "./lib/audit";
import { BUNDLE_MAX_BYTES, MODULES_PATH } from "@contracts/modules";
import { isAllowedHost } from "./lib/security";
import { loadTls } from "./lib/tls";
import { requestLog } from "./lib/requestLog";
import { inMaintenance } from "./lib/maintenance";
import { allowedHostsNow } from "./lib/serverHosts";
import { beginShutdown } from "./lib/shutdown";
import { registerEventRoutes } from "./events";
import { registerDeskChatRoutes } from "./desk/chat";
import { closeAllStreams } from "./lib/userEvents";
import { purgeTimerOps } from "./routers/timers";
import { purgeDecisions } from "./decisions/store";
import { purgeIdeas } from "./routers/ideas";
import { purgeWorkspace } from "./workspace/purge";
import { ollamaRefusal } from "./ai/ollama";
import { startSyncScheduler } from "./syncScheduler";
import { settleInFlightSyncs } from "./sync/orchestrator";
import { startBackupScheduler } from "./backup";
import { t } from "@contracts/i18n";
import { DEFAULT_ADMIN } from "@contracts/accounts";
import { defaultAdminPending, ensureAdmin, purgeExpiredAccess } from "./queries/accounts";

// Connect and migrate before answering anything (Postgres; PGlite in tests).
await initDb();
// A new server starts with its admin; its default password must go first.
if (!process.env.VITEST) {
  if (await ensureAdmin()) console.log(`[accounts] made the admin account "${DEFAULT_ADMIN}"`);
  if (await defaultAdminPending()) {
    console.warn(`[accounts] the "${DEFAULT_ADMIN}" account still has its default password: sign in and change it now`);
  }
}

const app = new Hono<{ Bindings: HttpBindings }>();

// A request line in absolute form ("GET https://x/… HTTP/1.1") sets the URL, scheme included,
// which clientIp reads to tell this server's own TLS: only a proxy is sent one.
app.use(async (c, next) => {
  const target = (c.env as HttpBindings | undefined)?.incoming?.url;
  if (target !== undefined && !target.startsWith("/")) return c.text("Bad Request", 400);
  await next();
});

// A rebound DNS name pointing at 127.0.0.1 must not reach the API or the SPA.
app.use(async (c, next) => {
  if (!isAllowedHost(c.req.header("host"), await allowedHostsNow())) {
    return c.text("Misdirected Request", 421);
  }
  await next();
});
// No HSTS: the header pins the whole host, every port, to https, whoever ends
// TLS (this server's own port, or a proxy). Once a browser stored it for localhost,
// the plain-HTTP servers on :47823 / :3000 no longer opened there.
// Outer: the Outlook task pane may be framed by Outlook, which secureHeaders would refuse.
app.use(outlookFrames);
app.use(secureHeaders({ strictTransportSecurity: false }));
app.use(localeMiddleware);
// JSON and populated SSR HTML travel compressed; the event stream never is:
// it would be held back until a buffer filled.
app.use("/api/trpc/*", compress());
app.use("/", compress());
app.use("/login", compress());
// Paths only: a query (tRPC inputs: an invite's token) or a webhook's token never reaches the log.
if (env.isProduction) app.use("/api/*", requestLog());
// JSON RPC stays small; only attachment uploads may carry files.
const smallBody = bodyLimit({ maxSize: 1024 * 1024 });
// A picture into an idea (contracts/ideaFiles.ts), with room for the multipart around it.
const ideaFileBody = bodyLimit({
  maxSize: IDEA_FILE_MAX_BYTES + 64 * 1024,
  onError: (c) => c.json({ error: t("server.ideas.fileTooLarge", { mb: IDEA_FILE_MAX_BYTES / 1024 / 1024 }) }, 413),
});
const uploadBody = bodyLimit({
  maxSize: UPLOAD_MAX_BYTES,
  onError: (c) => c.json({ error: t("server.attachments.tooLarge") }, 413),
});
const moduleBody = bodyLimit({
  maxSize: BUNDLE_MAX_BYTES,
  onError: (c) => c.json({ ok: false, reason: "too-large" }, 413),
});
// A whole mail dropped for its copy: up to MAIL_COPY_MAX_MB (docs/work/ideas/mail-copies.md R-1.4).
const mailCopyBody = (c: Parameters<typeof uploadBody>[0], next: Parameters<typeof uploadBody>[1]) =>
  bodyLimit({ maxSize: copyUploadMaxBytes(), onError: (cc) => cc.json({ error: t("server.mails.copy.tooLarge", { mb: env.mailCopyMaxMb }) }, 413) })(c, next);
app.use((c, next) =>
  c.req.method === "POST" && (/^\/api\/mail\/\d+\/copy$/.test(c.req.path) || c.req.path === "/api/outlook/copy")
    ? mailCopyBody(c, next)
    : c.req.method === "POST" && /^\/api\/issues\/[^/]+\/attachments$/.test(c.req.path)
    ? uploadBody(c, next)
    : c.req.method === "POST" && /^\/api\/ideas\/\d+\/files$/.test(c.req.path)
    ? ideaFileBody(c, next)
    : c.req.method === "POST" && c.req.path === `${MODULES_PATH}/upload`
      ? moduleBody(c, next)
      : smallBody(c, next),
);

/** The procedures a tRPC path names, or null for a path that doesn't decode (tRPC would throw on it). */
const procedurePath = (raw: string): string | null => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

// A restore replacing the database: no write lands meanwhile (said, not lost). The
// backup's own calls go on (a restore by hand when one failed and left the server closed).
app.use("/api/*", async (c, next) => {
  // Every procedure of a batch must be the backup's: a write batched behind one is refused too.
  const backupOnly = c.req.path.startsWith("/api/trpc/") && (procedurePath(c.req.path.slice("/api/trpc/".length)) ?? "").split(",").every((p) => p.startsWith("backup."));
  if (inMaintenance() && c.req.method !== "GET" && c.req.method !== "HEAD" && !backupOnly) {
    return c.json({ error: t("server.maintenance") }, 503);
  }
  await next();
});

// CSRF defence in depth (cookies are SameSite=Lax): state-changing requests
// must come from our own origin when the browser sends one.
app.use("/api/*", async (c, next) => {
  // What the browser says started the request: another site (another port of this host is
  // "same-site") can't send a write, nor open a query (some write), even without an Origin.
  // A webhook or an add-in key is no browser's cookie: nothing to forge there.
  const site = c.req.header("sec-fetch-site");
  const fromElsewhere = site === "cross-site" || site === "same-site";
  const keyed = c.req.path.startsWith("/api/hooks/") || /^Bearer\s/i.test(c.req.header("authorization") ?? "");
  if (fromElsewhere && !keyed && (c.req.method !== "GET" && c.req.method !== "HEAD" ? true : c.req.path.startsWith("/api/trpc/"))) {
    return c.json({ error: "Forbidden origin" }, 403);
  }
  // Queries too (some write): a browser without Sec-Fetch-Site still says Origin.
  if ((c.req.method !== "GET" && c.req.method !== "HEAD") || c.req.path.startsWith("/api/trpc/")) {
    const origin = c.req.header("origin");
    const host = c.req.header("host");
    if (origin && host) {
      // "null" (sandboxed/opaque origins) and garbage fail to parse: refuse.
      let originHost: string | null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost !== host) return c.json({ error: "Forbidden origin" }, 403);
    }
  }
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal Server Error" }, 500);
});

app.get("/api/health", async (c) =>
  (await pingDb()) ? c.json({ status: "ok" }) : c.json({ status: "error" }, 503),
);
registerAttachmentRoutes(app);
registerDownloadRoutes(app);
registerModuleRoutes(app);
registerStoreRoutes(app);
registerHookRoutes(app);
registerOutlookRoutes(app);
registerCopyRoutes(app);
registerIdeaFileRoutes(app);
registerEventRoutes(app);
registerDeskChatRoutes(app);
registerAuditRoutes(app);
app.use("/api/trpc/*", async (c) => {
  if (procedurePath(c.req.path) === null) return c.json({ error: "Bad Request" }, 400);
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    // c.env is undefined outside the Node server (app.request in tests).
    createContext: (opts) =>
      createContext(opts, (c.env as HttpBindings | undefined)?.incoming?.socket?.remoteAddress),
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

// Every call the server makes out is counted by host (Settings → Network).
installEgressLog();

// A local model on a public address is refused unless allowed (docs/work/ideas/triage.md R-2.8): said once, at start.
void ollamaRefusal().then((why) => {
  if (why === "public") console.warn(`[ai] OLLAMA_URL is not on this machine or its network: idea suggestions stay off (OLLAMA_ALLOW_PUBLIC=1 allows it)`);
  if (why === "unresolved") console.warn(`[ai] OLLAMA_URL's host doesn't resolve: idea suggestions stay off`);
});

// Background Jira sync. In dev the module is re-evaluated on reload: keep a
// single scheduler per process.
const g = globalThis as { __iklStopSync?: () => Promise<void>; __iklStopGone?: () => Promise<void> };
void g.__iklStopSync?.();
g.__iklStopSync = startSyncScheduler(env.syncIntervalMin);
// Pinned mails deleted in Outlook, looked for daily (docs/work/ideas/mail-copies.md R-1.11); not on test servers' short lives.
void g.__iklStopGone?.();
if (env.syncIntervalMin > 0) g.__iklStopGone = startGoneCheck();

if (env.isProduction || env.serveBuild) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);
  const purge = () =>
    void Promise.all([purgeExpiredSessions(), purgeExpiredAccess(), purgeDismissedNotifications(), purgeIdleModuleFiles(), purgeTrash(), purgeWebhookDeliveries(), purgeTimerOps(), purgeDecisions(), purgeIdeas(), purgeMailCopyReads(), purgeOrphanMailCopies(), purgeWorkspace(), purgeAudit()]).catch((e: unknown) =>
      console.warn(`[purge] ${String(e)}`),
    );
  const purging = env.isProduction ? setInterval(purge, 6 * 3600 * 1000) : undefined;
  purging?.unref();
  const renew = () =>
    void validLicenses()
      .then((l) => renewActivations(l))
      .then((done) => done.forEach((d) => !d.result.ok && console.warn(`[modules] licence ${d.id.slice(0, 6)}…: ${d.result.reason}`)))
      .catch((e: unknown) => console.warn(`[modules] renewal: ${String(e)}`));
  const renewing = env.isProduction ? setInterval(renew, ACTIVATION_DEFAULTS.renewEveryMs) : undefined;
  renewing?.unref();
  const stopBackups = env.isProduction ? startBackupScheduler() : undefined;
  if (env.isProduction) {
    purge();
    // Module licences active on this server: renewed before they end (WP-19).
    if (ACTIVATION_KEYS.length === 0) console.warn("[modules] no activation key in this build: licences are not tied to a server");
    renew();
  }

  const server = serve({ fetch: app.fetch, port: env.port }, () => {
    console.log(`Server running on http://localhost:${env.port}/`);
    if (env.serveBuild) console.log("Serving the production build with the development configuration");
    if (env.readOnly) console.log("Read-only (PROVIDERS_READ_ONLY / JIRA_READ_ONLY): writes to trackers are refused");
  });
  // Plain HTTP stays beside it: the health check, the deployment script and Tailscale use it.
  const tls = env.tlsDir ? loadTls(env.tlsDir) : null;
  if (tls && !tls.on) console.warn(`HTTPS off: ${tls.reason}`);
  if (tls?.on && tls.warning) console.warn(`[https] ${tls.warning}`);
  const secureServer = tls?.on
    ? serve({ fetch: app.fetch, port: env.httpsPort, createServer: createHttpsServer, serverOptions: { cert: tls.cert, key: tls.key } }, () => {
        console.log(`HTTPS on port ${env.httpsPort}`);
      })
    : undefined;
  secureServer?.on("error", (e: Error) => console.error(`HTTPS off: ${e.message}`));
  const servers = secureServer ? [server, secureServer] : [server];

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    // No new sync from now on; a sync cut mid-write would leave the outbox /
    // issues half updated, so the running ones finish first.
    beginShutdown();
    // Nor a purge, a licence renewal or a scheduled backup against a database about to close.
    clearInterval(purging);
    clearInterval(renewing);
    stopBackups?.();
    // Open event streams would keep server.close waiting forever.
    closeAllStreams();
    // Bounded: a pass stuck on Jira must not hold the exit until the hard kill.
    const atMost = (p: Promise<unknown> | undefined, ms: number) =>
      Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms).unref())]);
    await Promise.all([
      ...servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      atMost(g.__iklStopSync?.(), 5_000),
      atMost(g.__iklStopGone?.(), 5_000),
      settleInFlightSyncs(5_000),
    ]);
    await flushEgress().catch(() => undefined);
    await flushAudit().catch(() => undefined);
    await closeDb();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
