// The trackers a user connects: as many as they like, of any built type,
// each tested live, renamed, reconnected or archived (archived: its issues
// leave the lists, its time stays). The connection made with a Jira login
// before connections existed (legacy) is still mirrored from the user row.
import { env } from "../lib/env";
import { howOf, TOKEN_FORMS, webHostOf } from "../providers/forms";
import { assertSafeUrl } from "../lib/security";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { connections, connectionSync, containers, issues, worklogs, worklogSinks, type Connection, type User } from "@db/schema";
import { TIME_SINK_TYPES, TRACKER_TYPES, type TimeSinkType, type TrackerType } from "@contracts/providers";
import { openSecret, sealSecret } from "../lib/crypto";
import { webhookPath } from "../hooks";
import { providerName } from "@contracts/providerNames";
import { SINKS, TRACKERS } from "../providers/catalog";
import { sinkAdapter, sinkStatus, trackerAdapter, trackerStatus } from "../providers/registry";
import { boundSink, COMPANIONS, trackerOfSink } from "../sync/extraSinks";
import { t } from "@contracts/i18n";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { confirmJiraLogin, jiraLoginInput, type JiraIdentity } from "../lib/jiraLogin";
import { ownConnection, storeSecret } from "../providers/connections";
import { boundTracker, forgetProbes } from "../sync/engine";
import { providerCall } from "../providers/trpc";
import { pollDeviceLogin, startDeviceLogin } from "../providers/github/deviceLogin";
import { ghOk, type GitHubUser } from "../providers/github/client";

/** What a connection's service can do, as the catalogue declares it (a connection's probe may narrow it). */
function capabilitiesOf(type: string) {
  if (type in TRACKERS) return { role: "tracker" as const, capabilities: TRACKERS[type as TrackerType].capabilities, traits: TRACKERS[type as TrackerType].traits };
  if (type in SINKS) return { role: "timeSink" as const, capabilities: SINKS[type as TimeSinkType].capabilities };
  return null;
}

/** How a type is connected in the app. */


const label = z.string().trim().max(60).default("");

/** A Jira login confirmed live, as a connection's columns. */
const jiraColumns = (identity: JiraIdentity) => ({
  baseUrl: identity.siteUrl,
  remoteAccountId: identity.accountId,
  displayName: identity.displayName,
  avatarUrl: identity.avatarUrl,
  options: JSON.stringify({ deployment: identity.deployment, authType: identity.authType, username: identity.email }),
  status: "ok",
});

/** A connection's changeable options (its adapter's settings), each with its value now (the default when unset). */
function settingsOf(c: Connection): { key: string; choices: readonly string[]; value: string }[] {
  const adapter = trackerAdapter(c.type as TrackerType);
  if (!adapter?.settings) return [];
  let parsed: unknown = {};
  try {
    parsed = adapter.parseOptions(optionsOf(c));
  } catch {
    // unreadable options: the defaults show
  }
  return adapter.settings.map((s) => {
    const v = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[s.key] : undefined;
    return { ...s, value: typeof v === "string" ? v : s.choices[0] };
  });
}

/** The connection's options, as stored (JSON). */
const optionsOf = (c: Connection): Record<string, unknown> => {
  try {
    const o: unknown = JSON.parse(c.options);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Its tracker's options with `excludeRepos` set, or null when that tracker has no such option. */
function withExcluded(c: Connection, repos: string[]): unknown {
  const adapter = trackerAdapter(c.type as TrackerType);
  if (!adapter) return null;
  try {
    return adapter.parseOptions({ ...optionsOf(c), excludeRepos: repos });
  } catch {
    return null;
  }
}
const excludableOf = (c: Connection) => withExcluded(c, []) !== null;

/** A connection as the app shows it. */
async function shown(c: Connection) {
  const [sync] = await getDb()
    .select({ lastOkAt: connectionSync.lastOkAt, lastError: connectionSync.lastError, lastErrorAt: connectionSync.lastErrorAt })
    .from(connectionSync)
    .where(and(eq(connectionSync.connectionId, c.id), eq(connectionSync.stream, "issues")))
    .limit(1);
  return {
    id: c.id,
    type: c.type,
    name: providerName(c.type),
    label: c.label,
    host: new URL(c.baseUrl).host,
    /** Where its pages open in a browser (its API may live elsewhere: api.github.com) */
    webHost: webHostOf(c.type, c.baseUrl),
    displayName: c.displayName,
    /** The user's own id on it ("me" in its issues) */
    remoteAccountId: c.remoteAccountId,
    status: c.status,
    legacy: c.legacy === 1,
    lastSyncAt: sync?.lastOkAt ?? null,
    // An error older than the last success is stale.
    lastError: sync?.lastError && (!sync.lastOkAt || (sync.lastErrorAt ?? 0) >= sync.lastOkAt) ? sync.lastError : null,
    probedAt: c.probedAt,
    // Whether its tracker can leave some containers out of the sync (GitHub repositories).
    excludable: excludableOf(c),
    /** How it is connected, so reconnected (null: not from the app) */
    how: howOf(c.type as TrackerType),
    /** Built on a simulator, not verified on a real account: writes wait for the user (writesAllowed) */
    verified: statusOfType(c.type) !== "experimental",
    writesAllowed: c.writesAllowed === 1,
    /** A time sink standing in for one tracker connection (Tempo for its Jira): which kind, and which one (null: none chosen yet) */
    standsIn: COMPANIONS[c.type as TimeSinkType] ? { tracker: COMPANIONS[c.type as TimeSinkType]!.tracker, connectionId: trackerOfSink(c) } : null,
    /** The options the person may change, with their current value */
    settings: settingsOf(c),
    ...(capabilitiesOf(c.type) ?? { role: null, capabilities: null }),
  };
}

/** A tracker's or a time sink's build status, by type. */
const statusOfType = (type: string) => ((TIME_SINK_TYPES as readonly string[]).includes(type) ? sinkStatus(type as TimeSinkType) : trackerStatus(type as TrackerType));

const isJiraCloud = (siteUrl: string) => {
  try {
    return /\.atlassian\.net$/i.test(new URL(siteUrl).hostname);
  } catch {
    return false;
  }
};

/**
 * A self-hosted tracker is reached on the server's own network. In production with no
 * REMOTE_ALLOWED_HOSTS to bound it, only an admin adds one (a member could make the server
 * reach any address it can); listing the hosts there opens them to everyone.
 */
function assertMayAddSelfHosted(user: Pick<User, "role">) {
  if (env.isProduction && env.remoteAllowedHosts.length === 0 && user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: t("server.connections.selfHostedAdmin") });
  }
}

export const connectionsRouter = createRouter({
  /** The user's connections, with their service's name and what it can do: the app decides by capability, never by type. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getDb()
      .select()
      .from(connections)
      .where(and(eq(connections.userId, ctx.user.id), isNull(connections.archivedAt)))
      .orderBy(asc(connections.id));
    return Promise.all(rows.map(shown));
  }),

  /** Every tracker type, how it is connected, and whether inkledger can connect it yet. */
  catalog: protectedProcedure.query(() =>
    [...TRACKER_TYPES, ...TIME_SINK_TYPES].map((type) => ({
      type,
      role: (TIME_SINK_TYPES as readonly string[]).includes(type) ? ("timeSink" as const) : ("tracker" as const),
      name: providerName(type),
      status: statusOfType(type),
      how: howOf(type),
      /** A token connection on a server of the user's own: its address is asked */
      asksAddress: TOKEN_FORMS[type]?.apiBase === null,
    })),
  ),

  /** A new Jira connection, its login confirmed live. Another account's Jira login stays theirs. */
  addJira: protectedProcedure.input(jiraLoginInput.extend({ label })).mutation(async ({ input, ctx }) => {
    if (!isJiraCloud(input.siteUrl)) assertMayAddSelfHosted(ctx.user);
    const identity = await confirmJiraLogin(input);
    const db = getDb();
    const [taken] = await db
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.type, "jira"), eq(connections.baseUrl, identity.siteUrl), eq(connections.remoteAccountId, identity.accountId), ne(connections.userId, ctx.user.id), isNull(connections.archivedAt)))
      .limit(1);
    if (taken) throw new TRPCError({ code: "CONFLICT", message: t("server.auth.jiraAccountInUse") });
    const [mine] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.userId, ctx.user.id), eq(connections.type, "jira"), eq(connections.baseUrl, identity.siteUrl), eq(connections.remoteAccountId, identity.accountId)))
      .limit(1);
    // The same Jira account again: the one already there comes back (unarchived, new credentials).
    const [saved] = mine
      ? await db.update(connections).set({ ...jiraColumns(identity), archivedAt: null, ...(input.label ? { label: input.label } : {}) }).where(eq(connections.id, mine.id)).returning()
      : await db.insert(connections).values({ userId: ctx.user.id, type: "jira", label: input.label, encryptedSecret: "", ...jiraColumns(identity) }).returning();
    await storeSecret(saved.id, identity.secret);
    await forgetProbes(saved.id);
    return shown(saved);
  }),

  /** New credentials for a connection, for the same account on the same site. */
  reconnectJira: protectedProcedure.input(jiraLoginInput.extend({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    if (!isJiraCloud(input.siteUrl)) assertMayAddSelfHosted(ctx.user);
    const conn = await ownConnection(ctx.user.id, input.id);
    const identity = await confirmJiraLogin(input);
    if (identity.siteUrl !== conn.baseUrl || identity.accountId !== conn.remoteAccountId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: t("server.connections.otherAccount") });
    }
    const [saved] = await getDb().update(connections).set(jiraColumns(identity)).where(eq(connections.id, conn.id)).returning();
    await storeSecret(saved.id, identity.secret);
    await forgetProbes(saved.id);
    return shown(saved);
  }),


  /** Tries the connection live: who it signs in as, and what its service has on (kept for the app). */
  test: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const conn = await ownConnection(ctx.user.id, input.id);
    const b = boundTracker(conn);
    if (!b) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.connections.notBuilt", { provider: providerName(conn.type) }) });
    const meta = () => ({ signal: AbortSignal.timeout(30_000), correlationId: `test-${conn.id}-${Date.now()}` });
    const me = await providerCall(() => b.verify(meta()));
    const probe = await providerCall(() => b.probe(meta()));
    const [saved] = await getDb()
      .update(connections)
      .set({ probe: JSON.stringify(probe), probedAt: new Date(), status: "ok" })
      .where(eq(connections.id, conn.id))
      .returning();
    return { connection: await shown(saved), signedInAs: me.name, sources: probe.activeSources.map((s) => s.name) };
  }),

  /**
   * A tracker connected with a personal token (and its address when
   * self-hosted): the token tried live before anything is kept; the same
   * account again is the connection already there, with the new token.
   */
  connectToken: protectedProcedure
    .input(z.object({ type: z.enum([...TRACKER_TYPES, ...TIME_SINK_TYPES]), baseUrl: z.string().trim().max(300).optional(), token: z.string().trim().min(8).max(4000), label }))
    .mutation(async ({ ctx, input }) => {
      const form = TOKEN_FORMS[input.type];
      const isSink = (TIME_SINK_TYPES as readonly string[]).includes(input.type);
      if (!form || !(isSink ? sinkAdapter(input.type as TimeSinkType) : trackerAdapter(input.type as TrackerType))) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.connections.notConnectable", { provider: providerName(input.type) }) });
      const baseUrl = (form.apiBase ?? input.baseUrl ?? "").replace(/\/+$/, "");
      if (!baseUrl) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.url.invalid") });
      if (form.selfHosted) assertMayAddSelfHosted(ctx.user);
      await assertSafeUrl(baseUrl, { allowedHosts: form.selfHosted ? env.remoteAllowedHosts : [], network: form.selfHosted ? "private" : "public" }).catch((e: unknown) => {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
      });
      const db = getDb();
      const [made] = await db.insert(connections).values({ userId: ctx.user.id, type: input.type, label: input.label, baseUrl, remoteAccountId: "", encryptedSecret: "", options: "{}", status: "ok" }).returning();
      try {
        await storeSecret(made.id, input.token);
        const sealed = { ...made, encryptedSecret: sealSecret(input.token, made.id) };
        const b = isSink ? boundSink(sealed) : boundTracker(sealed);
        if (!b) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.connections.notConnectable", { provider: providerName(input.type) }) });
        const me = await providerCall(() => b.verify({ signal: AbortSignal.timeout(20_000), correlationId: `connect-${made.id}` }));
        // The same account on the same server: that connection, with the new token.
        const [same] = await db
          .select()
          .from(connections)
          .where(and(eq(connections.userId, ctx.user.id), eq(connections.type, input.type), eq(connections.baseUrl, baseUrl), eq(connections.remoteAccountId, me.remoteId), ne(connections.id, made.id)))
          .limit(1);
        if (same) {
          await db.delete(connections).where(eq(connections.id, made.id));
          await db.update(connections).set({ archivedAt: null, status: "ok", displayName: me.name, ...(input.label ? { label: input.label } : {}) }).where(eq(connections.id, same.id));
          await storeSecret(same.id, input.token);
          await forgetProbes(same.id);
          const [row] = await db.select().from(connections).where(eq(connections.id, same.id));
          return shown(row);
        }
        const [row] = await db.update(connections).set({ remoteAccountId: me.remoteId, displayName: me.name, avatarUrl: me.avatarUrl ?? null }).where(eq(connections.id, made.id)).returning();
        return shown(row);
      } catch (e) {
        await db.delete(connections).where(eq(connections.id, made.id));
        throw e;
      }
    }),

  /** A new token for a token connection (the old one expired or was revoked): tried live first. */
  reconnectToken: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), token: z.string().trim().min(8).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      const conn = await ownConnection(ctx.user.id, input.id);
      const b = boundTracker({ ...conn, encryptedSecret: sealSecret(input.token, conn.id) });
      if (!b || howOf(conn.type as TrackerType) !== "token") throw new TRPCError({ code: "BAD_REQUEST", message: t("server.connections.notConnectable", { provider: providerName(conn.type) }) });
      const me = await providerCall(() => b.verify({ signal: AbortSignal.timeout(20_000), correlationId: `reconnect-${conn.id}` }));
      if (conn.remoteAccountId && me.remoteId !== conn.remoteAccountId) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.connections.otherAccount") });
      await storeSecret(conn.id, input.token);
      await getDb().update(connections).set({ status: "ok" }).where(eq(connections.id, conn.id));
      await forgetProbes(conn.id);
      return { ok: true };
    }),

  /**
   * Writes on an adapter built on a simulator, not verified on a real
   * account yet: off until the user allows them on this connection.
   */
  allowWrites: protectedProcedure.input(z.object({ id: z.number().int().positive(), on: z.boolean() })).mutation(async ({ ctx, input }) => {
    const conn = await ownConnection(ctx.user.id, input.id);
    await getDb().update(connections).set({ writesAllowed: input.on ? 1 : 0 }).where(eq(connections.id, conn.id));
    return { ok: true };
  }),

  /**
   * The tracker connection a time sink stands in for (Tempo: its Jira). From
   * now on that tracker's new worklogs are filed on the sink; older ones stay
   * the tracker's. Null: none, the tracker's own again for new worklogs.
   */
  standIn: protectedProcedure.input(z.object({ id: z.number().int().positive(), trackerId: z.number().int().positive().nullable() })).mutation(async ({ ctx, input }) => {
    const conn = await ownConnection(ctx.user.id, input.id);
    const k = COMPANIONS[conn.type as TimeSinkType];
    if (!k) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.connections.noStandIn", { provider: providerName(conn.type) }) });
    let account: string | null = null;
    if (input.trackerId !== null) {
      const tracker = await ownConnection(ctx.user.id, input.trackerId);
      if (tracker.type !== k.tracker || tracker.archivedAt) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.connections.noStandIn", { provider: providerName(conn.type) }) });
      account = tracker.remoteAccountId;
    }
    let options: Record<string, unknown> = {};
    try {
      options = JSON.parse(conn.options) as Record<string, unknown>;
    } catch {
      options = {};
    }
    // Time it filed for its current tracker and hasn't sent yet: moving the stand-in now would
    // leave it filed nowhere (the tracker's rows wait for this sink). Sent, or discarded, first.
    const current = typeof options[k.option] === "number" ? (options[k.option] as number) : null;
    if (current !== null && current !== input.trackerId) {
      const [waiting] = await getDb()
        .select({ id: worklogSinks.id })
        .from(worklogSinks)
        .innerJoin(worklogs, eq(worklogs.id, worklogSinks.worklogId))
        .where(and(eq(worklogSinks.sinkConnectionId, conn.id), ne(worklogSinks.state, "synced"), eq(worklogs.connectionId, current)))
        .limit(1);
      if (waiting) throw new TRPCError({ code: "CONFLICT", message: t("server.connections.standInBusy", { provider: providerName(conn.type) }) });
    }
    const rest = Object.fromEntries(Object.entries(options).filter(([key]) => key !== k.option && key !== "accountId"));
    const next = input.trackerId === null ? rest : { ...rest, [k.option]: input.trackerId, accountId: account };
    await getDb().update(connections).set({ options: JSON.stringify(next) }).where(eq(connections.id, conn.id));
    await forgetProbes(conn.id);
    return { ok: true };
  }),

  /** Signing in to GitHub: the code to enter on github.com. */
  githubStart: protectedProcedure.input(z.object({ label })).mutation(async ({ ctx, input }) => {
    return providerCall(() => startDeviceLogin(ctx.user.id, input.label));
  }),

  /** Whether the user authorized on GitHub; once they did, the connection (made, or the same account's updated). */
  githubPoll: protectedProcedure.input(z.object({ flowId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const r = await providerCall(() => pollDeviceLogin(ctx.user.id, input.flowId));
    if (r.state !== "authorized") return r;
    const apiBase = "https://api.github.com";
    const me = await providerCall(() => ghOk<GitHubUser>({ apiBase, token: r.token }, "/user"));
    const db = getDb();
    const values = { baseUrl: apiBase, remoteAccountId: String(me.id), displayName: me.name || me.login, avatarUrl: me.avatar_url ?? null, status: "ok" };
    const [mine] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.userId, ctx.user.id), eq(connections.type, "github"), eq(connections.baseUrl, apiBase), eq(connections.remoteAccountId, values.remoteAccountId)))
      .limit(1);
    // The same account signed in again (a reconnect): its options (repositories left out…) stay.
    const [saved] = mine
      ? await db.update(connections).set({ ...values, archivedAt: null, ...(r.label ? { label: r.label } : {}) }).where(eq(connections.id, mine.id)).returning()
      : await db.insert(connections).values({ userId: ctx.user.id, type: "github", label: r.label, encryptedSecret: "", options: "{}", ...values }).returning();
    await storeSecret(saved.id, r.token);
    await forgetProbes(saved.id);
    return { state: "done" as const, connection: await shown(saved) };
  }),

  /** The containers (repositories, projects) the connection has seen, and whether each is left out of the sync. */
  containers: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const conn = await ownConnection(ctx.user.id, input.id);
    const excluded = new Set(((optionsOf(conn).excludeRepos as string[] | undefined) ?? []).map((k) => k.toLowerCase()));
    const rows = await getDb().select({ id: containers.id, key: containers.key, name: containers.name }).from(containers).where(eq(containers.connectionId, conn.id)).orderBy(asc(containers.key));
    return rows.map((c) => ({ ...c, excluded: excluded.has(c.key.toLowerCase()) }));
  }),

  /**
   * Which repositories to leave out of the sync. Their issues leave the
   * lists at once (gone, "excluded"; their time stays); one brought back
   * returns with the next sync, a full one.
   */
  setExcluded: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), keys: z.array(z.string().min(1).max(200)).max(500) }))
    .mutation(async ({ input, ctx }) => {
      const conn = await ownConnection(ctx.user.id, input.id);
      const options = withExcluded(conn, input.keys);
      if (options === null) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.connections.notExcludable", { provider: providerName(conn.type) }) });
      const db = getDb();
      await db.update(connections).set({ options: JSON.stringify(options) }).where(eq(connections.id, conn.id));
      const lower = input.keys.map((k) => k.toLowerCase());
      if (lower.length) {
        await db
          .update(issues)
          .set({ goneAt: new Date(), goneReason: "excluded" })
          .where(and(eq(issues.connectionId, conn.id), isNull(issues.goneAt), sql`lower(${issues.projectKey}) IN (${sql.join(lower.map((k) => sql`${k}`), sql`, `)})`));
      }
      // The next sync reads everything again: what came back returns, what is left out stays gone.
      await db.update(connectionSync).set({ checkpoint: null }).where(and(eq(connectionSync.connectionId, conn.id), eq(connectionSync.stream, "issues")));
      await forgetProbes(conn.id);
      return { excluded: input.keys.length };
    }),

  /**
   * Webhooks of a connection (D5, off by default): whether its tracker sends
   * them, and when on the address and secret to register there.
   */
  webhook: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const conn = await ownConnection(ctx.user.id, input.id);
    const available = !!trackerAdapter(conn.type as TrackerType)?.webhook;
    if (!available || !conn.webhookSecret) return { available, on: false as const };
    const secret = openSecret(conn.webhookSecret, conn.id).plain;
    return { available, on: true as const, path: webhookPath(secret, conn.id), secret };
  }),

  /** Webhooks on (a new secret, so a new address) or off (deliveries refused). */
  setWebhook: protectedProcedure.input(z.object({ id: z.number().int().positive(), on: z.boolean() })).mutation(async ({ ctx, input }) => {
    const conn = await ownConnection(ctx.user.id, input.id);
    if (input.on && !trackerAdapter(conn.type as TrackerType)?.webhook) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.connections.noWebhooks") });
    await getDb()
      .update(connections)
      .set({ webhookSecret: input.on ? sealSecret(randomBytes(32).toString("base64url"), conn.id) : null })
      .where(eq(connections.id, conn.id));
    return { ok: true };
  }),

  /** One of the connection's changeable options; the next pass reads everything again with it. */
  setOption: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), key: z.string().min(1).max(40), value: z.string().min(1).max(40) }))
    .mutation(async ({ input, ctx }) => {
      const conn = await ownConnection(ctx.user.id, input.id);
      const adapter = trackerAdapter(conn.type as TrackerType);
      const setting = adapter?.settings?.find((s) => s.key === input.key);
      if (!adapter || !setting || !setting.choices.includes(input.value)) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.input.invalid") });
      const next = { ...optionsOf(conn), [input.key]: input.value };
      adapter.parseOptions(next);
      const db = getDb();
      const [saved] = await db.update(connections).set({ options: JSON.stringify(next) }).where(eq(connections.id, conn.id)).returning();
      await db.update(connectionSync).set({ checkpoint: null }).where(and(eq(connectionSync.connectionId, conn.id), eq(connectionSync.stream, "issues")));
      return shown(saved);
    }),

  rename: protectedProcedure.input(z.object({ id: z.number().int().positive(), label })).mutation(async ({ input, ctx }) => {
    const conn = await ownConnection(ctx.user.id, input.id);
    const [saved] = await getDb().update(connections).set({ label: input.label }).where(eq(connections.id, conn.id)).returning();
    return shown(saved);
  }),

  /** Archived: its issues leave every list and its sync stops; its time stays. Adding it again brings it back. */
  archive: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const conn = await ownConnection(ctx.user.id, input.id);
    await getDb().update(connections).set({ archivedAt: new Date() }).where(eq(connections.id, conn.id));
    return { ok: true };
  }),
});
