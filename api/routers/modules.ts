import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, count, eq, gte, not, like, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createRouter, permProcedure, protectedProcedure } from "../middleware";
import { can } from "../queries/accounts";
import { getDb } from "../queries/connection";
import { moduleStorage, worklogs } from "@db/schema";
import { FILE_MAX_BYTES, FILE_TYPES, PROGRESS_FILE_FORMAT, STORAGE_MAX_BYTES, STORAGE_MAX_KEYS } from "@contracts/modules";
import { moduleIdSchema } from "@contracts/modulesSchema";
import { deleteModuleFile, getModuleFile, putModuleFile, removeModuleFiles } from "../modules/files";
import { env } from "../lib/env";
import { startOfWeek } from "@contracts/time";
import { realSecondsByDay, realSecondsTotal } from "@contracts/placement";
import { geocode, weatherAt } from "../weather/openMeteo";
import { t } from "@contracts/i18n";
import { extraKey } from "../modules/keys";
import { acceptToken, activate, activationsOf, activationStates, deactivate, offlineCode } from "../modules/activation";
import { StoreError } from "../store/client";
import { LICENSE_FILE_FORMAT } from "@contracts/store";
import {
  isActive,
  licenseIssuer,
  listModules,
  saveLicenses,
  storedLicenses,
  uninstall,
  validLicenses,
  verifyLicense,
} from "../modules/registry";

/** Server-wide: for whoever may manage the Store and licences. */
const store = permProcedure("manageStore");
/** Running the modules (their storage, files, totals): who may use them. */
const use = permProcedure("useModules");

// Keys starting with "__" belong to the host (e.g. "__since").
const storageKey = z.string().regex(/^(?!__)[\w.-]{1,64}$/);
const SINCE = "__since";
// Present (any value) when this user turned the module off.
const OFF = "__off";
const moduleKeys = like(moduleStorage.key, "\\_\\_%");
const storageRef = z.object({ moduleId: moduleIdSchema, key: storageKey });
const fileRef = z.object({ moduleId: moduleIdSchema, key: z.string().regex(/^[\w.|,:-]{1,120}$/) });
// Base64 of FILE_MAX_BYTES, rounded up.
const FILE_MAX_B64 = Math.ceil(FILE_MAX_BYTES / 3) * 4;

/** Storage is the module's own, and only while it is active. */
async function requireActive(moduleId: string) {
  if (!(await isActive(moduleId))) {
    throw new TRPCError({ code: "FORBIDDEN", message: t("server.modules.inactive") });
  }
}


type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One writer at a time per user and module (caps and revisions hold under parallel writes). */
const lockStorage = (tx: Tx, userId: number, moduleId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`module-storage:${moduleId}`}), ${userId})`);

/**
 * One write of a module's key: under the user+module lock, within the key cap; with `ifRevision`
 * only over that revision (else the latest comes back). Every write moves the revision on.
 */
async function writeStorage(userId: number, moduleId: string, key: string, value: unknown, ifRevision?: number) {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json) > STORAGE_MAX_BYTES) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: t("server.modules.storageTooLarge") });
  }
  const mine = and(eq(moduleStorage.userId, userId), eq(moduleStorage.moduleId, moduleId));
  return getDb().transaction(async (tx): Promise<{ revision: number } | { conflict: true; value: unknown; revision: number }> => {
    await lockStorage(tx, userId, moduleId);
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(moduleStorage).where(and(mine, not(moduleKeys)));
    const [exists] = await tx
      .select({ value: moduleStorage.value, revision: moduleStorage.revision })
      .from(moduleStorage)
      .where(and(mine, eq(moduleStorage.key, key)))
      .limit(1);
    const current = exists?.revision ?? 0;
    if (ifRevision !== undefined && ifRevision !== current) {
      return { conflict: true as const, value: exists ? (JSON.parse(exists.value) as unknown) : null, revision: current };
    }
    if (!exists && n >= STORAGE_MAX_KEYS) {
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: t("server.modules.storageFull") });
    }
    const revision = current + 1;
    await tx
      .insert(moduleStorage)
      .values({ userId, moduleId, key, value: json, revision, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [moduleStorage.userId, moduleStorage.moduleId, moduleStorage.key],
        set: { value: json, revision, updatedAt: new Date() },
      });
    return { revision };
  });
}

/**
 * When this user's progress in a module starts: set the first time the module
 * asks, so a freshly installed module counts from zero. Data saved before
 * this existed got 0 (the whole history) in migration 0004.
 */
async function sinceOf(db: Db, userId: number, moduleId: string): Promise<number> {
  const at = Date.now();
  await db
    .insert(moduleStorage)
    .values({ userId, moduleId, key: SINCE, value: String(at), updatedAt: new Date(at) })
    .onConflictDoNothing();
  const [row] = await db
    .select({ value: moduleStorage.value })
    .from(moduleStorage)
    .where(and(eq(moduleStorage.userId, userId), eq(moduleStorage.moduleId, moduleId), eq(moduleStorage.key, SINCE)))
    .limit(1);
  return Number(row?.value ?? at) || 0;
}

/** Signs a progress file so only this server's own exports come back in. */
const progressSig = (body: string) =>
  createHmac("sha256", `${PROGRESS_FILE_FORMAT}\n${env.sessionSecret}`).update(body).digest("base64url");

const progressBody = (module: string, since: number, data: Record<string, unknown>) =>
  JSON.stringify({ module, since, data: Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))) });

/** A licence id shown without being the whole licence. */
const mask = (id: string) => (id.length > 6 ? `${id.slice(0, 6)}…` : id);

/** The stored licence of a product, or NOT_FOUND. */
async function licenseOf(product: string) {
  const l = (await validLicenses()).find((x) => x.product === product);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: t("server.store.noLicense") });
  return l;
}

const activationMessage = (reason: string) =>
  reason === "limit"
    ? t("server.store.activationLimit")
    : reason === "rate"
      ? t("server.store.activationRate")
      : reason === "off" || reason === "unreachable"
        ? t("server.store.activationUnreachable")
        : t("server.store.badActivation");

export const modulesRouter = createRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const texts = await storedLicenses();
    const licenses = texts.flatMap((text) => {
      const l = verifyLicense(text);
      return l.ok
        ? [{ id: l.payload.id, label: mask(l.payload.id), product: l.payload.product, issued: l.payload.issued, issuer: licenseIssuer(text) }]
        : [];
    });
    const off = await getDb()
      .select({ moduleId: moduleStorage.moduleId })
      .from(moduleStorage)
      .where(and(eq(moduleStorage.userId, ctx.user.id), eq(moduleStorage.key, OFF)));
    // Who may not use modules runs none (a store manager still sees them, to manage).
    return { modules: await listModules(), licenses, extraKey: extraKey() !== null, off: off.map((r) => r.moduleId), canUse: can(ctx.user, "useModules") };
  }),

  /**
   * Where a product's licence stands on this server (WP-19): activation asked
   * or not, its state here, and (from the store) the servers it is active on.
   */
  activation: store.input(z.object({ product: z.string().min(1) })).query(async ({ input }) => {
    const l = await licenseOf(input.product);
    const state = (await activationStates([l])).get(l.id) ?? { state: "missing" as const };
    if (state.state === "not-required" || !env.storeUrl) return { required: state.state !== "not-required", state, servers: null, offline: !env.storeUrl };
    const servers = await activationsOf(l.text).catch(() => null);
    return { required: true, state, servers, offline: false };
  }),

  /** Activates (or renews) the licence on this server now. */
  activate: store.input(z.object({ product: z.string().min(1) })).mutation(async ({ input }) => {
    const l = await licenseOf(input.product);
    const r = await activate(l.text, l.id);
    if (!r.ok) throw new TRPCError({ code: r.reason === "limit" ? "PRECONDITION_FAILED" : "BAD_REQUEST", message: activationMessage(r.reason) });
    return r;
  }),

  /** Frees this server's slot (to use the licence on another one). */
  deactivate: store.input(z.object({ product: z.string().min(1) })).mutation(async ({ input }) => {
    const l = await licenseOf(input.product);
    await deactivate(l.text, l.id).catch((e: unknown) => {
      throw new TRPCError({ code: "BAD_REQUEST", message: activationMessage(e instanceof StoreError && e.detail === "rate" ? "rate" : "unreachable") });
    });
    return { ok: true };
  }),

  /** Offline (no store from here): the code to take to the store's page, and the token brought back. */
  offlineCode: store.input(z.object({ product: z.string().min(1) })).query(async ({ input }) => {
    const l = await licenseOf(input.product);
    return { code: offlineCode(l.id), page: "/activate-offline" };
  }),

  acceptToken: store.input(z.object({ product: z.string().min(1), token: z.string().trim().min(10).max(4000) })).mutation(async ({ input }) => {
    const l = await licenseOf(input.product);
    if (!(await acceptToken(input.token, l.id, l.product))) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.badActivation") });
    return { ok: true };
  }),

  /** The licence of a product as a file, to keep or to move to another server. */
  exportLicense: store.input(z.object({ product: z.string().min(1) })).query(async ({ input }) => {
    const text = (await storedLicenses()).find((x) => {
      const v = verifyLicense(x);
      return v.ok && v.payload.product === input.product;
    });
    if (!text) throw new TRPCError({ code: "NOT_FOUND", message: t("server.store.noLicense") });
    return { format: LICENSE_FILE_FORMAT, product: input.product, license: text };
  }),

  // Licences arrive only through the store (api/routers/store.ts); here they can be removed.
  removeLicense: store
    .input(z.union([z.object({ id: z.string().min(1) }), z.object({ product: z.string().min(1) })]))
    .mutation(async ({ input }) => {
      const texts = await storedLicenses();
      await saveLicenses(
        texts.filter((x) => {
          const v = verifyLicense(x);
          if (!v.ok) return true;
          return "id" in input ? v.payload.id !== input.id : v.payload.product !== input.product;
        }),
      );
    }),

  uninstall: store
    .input(z.object({ id: moduleIdSchema }))
    .mutation(async ({ input }) => {
      const removed = uninstall(input.id);
      // Reinstalling starts from zero: its saved progress goes too (exportProgress keeps a copy).
      if (removed) {
        await getDb().delete(moduleStorage).where(eq(moduleStorage.moduleId, input.id));
        await removeModuleFiles(input.id);
      }
      return { removed };
    }),

  /** Turns one module off (or back on) for this user, on every device. */
  setEnabled: use
    .input(z.object({ id: moduleIdSchema, enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const row = and(eq(moduleStorage.userId, ctx.user.id), eq(moduleStorage.moduleId, input.id), eq(moduleStorage.key, OFF));
      if (input.enabled) await db.delete(moduleStorage).where(row);
      else
        await db
          .insert(moduleStorage)
          .values({ userId: ctx.user.id, moduleId: input.id, key: OFF, value: "true", updatedAt: new Date() })
          .onConflictDoNothing();
      return { enabled: input.enabled };
    }),

  /** This user's progress in a module as a signed file. */
  exportProgress: use.input(z.object({ id: moduleIdSchema })).query(async ({ ctx, input }) => {
    await requireActive(input.id);
    const db = getDb();
    const since = await sinceOf(db, ctx.user.id, input.id);
    const rows = await db
      .select({ key: moduleStorage.key, value: moduleStorage.value })
      .from(moduleStorage)
      .where(and(eq(moduleStorage.userId, ctx.user.id), eq(moduleStorage.moduleId, input.id), not(moduleKeys)));
    const data = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
    const body = progressBody(input.id, since, data);
    return { format: PROGRESS_FILE_FORMAT, module: input.id, since, data, sig: progressSig(body) };
  }),

  /** Puts back a progress file exported from this server, replacing what the module has. */
  importProgress: use.input(z.object({ text: z.string().max(256 * 1024) })).mutation(async ({ ctx, input }) => {
    const file = z
      .object({
        format: z.literal(PROGRESS_FILE_FORMAT),
        module: moduleIdSchema,
        since: z.number().int().min(0),
        data: z.record(storageKey, z.unknown()),
        sig: z.string(),
      })
      .safeParse((() => {
        try {
          return JSON.parse(input.text) as unknown;
        } catch {
          return null;
        }
      })());
    if (!file.success) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.modules.badProgress") });
    const { module, since, data, sig } = file.data;
    const want = Buffer.from(progressSig(progressBody(module, since, data)));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: t("server.modules.badProgress") });
    }
    await requireActive(module);
    const entries = Object.entries(data).map(([key, value]) => [key, JSON.stringify(value ?? null)] as const);
    if (entries.length > STORAGE_MAX_KEYS || entries.some(([, v]) => Buffer.byteLength(v) > STORAGE_MAX_BYTES)) {
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: t("server.modules.storageFull") });
    }
    const now = new Date();
    await getDb().transaction(async (tx) => {
      await lockStorage(tx, ctx.user.id, module);
      const mine = and(eq(moduleStorage.userId, ctx.user.id), eq(moduleStorage.moduleId, module), not(eq(moduleStorage.key, OFF)));
      // Revisions are never imported: each key moves past the one an open tab may hold.
      const before = new Map(
        (await tx.select({ key: moduleStorage.key, revision: moduleStorage.revision }).from(moduleStorage).where(mine)).map(r => [r.key, r.revision]),
      );
      // Everything but the on/off switch, which stays as the user set it.
      await tx.delete(moduleStorage).where(mine);
      await tx.insert(moduleStorage).values(
        [[SINCE, String(since)] as const, ...entries].map(([key, value]) => ({ userId: ctx.user.id, moduleId: module, key, value, revision: (before.get(key) ?? 0) + 1, updatedAt: now })),
      );
    });
    return { module };
  }),

  storageGet: use.input(storageRef).query(async ({ ctx, input }) => {
    await requireActive(input.moduleId);
    const [row] = await getDb()
      .select({ value: moduleStorage.value, revision: moduleStorage.revision })
      .from(moduleStorage)
      .where(
        and(
          eq(moduleStorage.userId, ctx.user.id),
          eq(moduleStorage.moduleId, input.moduleId),
          eq(moduleStorage.key, input.key),
        ),
      )
      .limit(1);
    // revision 0: no value (storage.update writes over what it read, or is told what is there now).
    return { value: row ? (JSON.parse(row.value) as unknown) : null, revision: row?.revision ?? 0 };
  }),

  storageSet: use
    .input(storageRef.extend({ value: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      await requireActive(input.moduleId);
      await writeStorage(ctx.user.id, input.moduleId, input.key, input.value);
    }),

  /** Newer hosts' storage.update: written only over `ifRevision`, else the latest comes back to merge. */
  storageSetIf: use
    .input(storageRef.extend({ value: z.unknown(), ifRevision: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      await requireActive(input.moduleId);
      return writeStorage(ctx.user.id, input.moduleId, input.key, input.value, input.ifRevision);
    }),

  storageDelete: use.input(storageRef).mutation(async ({ ctx, input }) => {
    await requireActive(input.moduleId);
    await getDb()
      .delete(moduleStorage)
      .where(
        and(
          eq(moduleStorage.userId, ctx.user.id),
          eq(moduleStorage.moduleId, input.moduleId),
          eq(moduleStorage.key, input.key),
        ),
      );
  }),

  /** For the host API: a cached file of this module (base64), null when missing. */
  fileGet: use.input(fileRef).query(async ({ ctx, input }) => {
    await requireActive(input.moduleId);
    const row = await getModuleFile(ctx.user.id, input.moduleId, input.key);
    return row ? { contentType: row.contentType, data: row.data.toString("base64") } : null;
  }),

  filePut: use
    .input(fileRef.extend({ contentType: z.enum(FILE_TYPES), data: z.string().max(FILE_MAX_B64) }))
    .mutation(async ({ ctx, input }) => {
      await requireActive(input.moduleId);
      const data = Buffer.from(input.data, "base64");
      if (data.length === 0 || data.length > FILE_MAX_BYTES) {
        throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: t("server.modules.storageTooLarge") });
      }
      await putModuleFile(ctx.user.id, input.moduleId, input.key, input.contentType, data);
    }),

  fileDelete: use.input(fileRef).mutation(async ({ ctx, input }) => {
    await requireActive(input.moduleId);
    await deleteModuleFile(ctx.user.id, input.moduleId, input.key);
  }),

  /** For the host API: the weather now near a place (server-side, cached). */
  weather: use
    .input(z.object({ moduleId: moduleIdSchema, lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }))
    .query(async ({ input }) => {
      await requireActive(input.moduleId);
      return weatherAt(input.lat, input.lon);
    }),

  /** For the host API: places matching a name (a module's location setting). */
  geocode: use
    .input(z.object({ moduleId: moduleIdSchema, query: z.string().max(80), language: z.enum(["en", "it"]) }))
    .query(async ({ input }) => {
      await requireActive(input.moduleId);
      return geocode(input.query, input.language);
    }),

  /** For the host API: hours this user worked (parallel work once) since the module started counting (see sinceOf). */
  totals: use.input(z.object({ moduleId: moduleIdSchema })).query(async ({ ctx, input }) => {
    await requireActive(input.moduleId);
    const db = getDb();
    const since = await sinceOf(db, ctx.user.id, input.moduleId);
    // This week, from Monday or from since if later (a module installed mid-week).
    const weekFrom = new Date(Math.max(startOfWeek(new Date()).getTime(), since));
    const rows = await db
      .select({ start: worklogs.started, seconds: worklogs.timeSpentSeconds })
      .from(worklogs)
      .where(and(eq(worklogs.userId, ctx.user.id), gte(worklogs.started, new Date(since))));
    return {
      lifetimeLoggedSeconds: realSecondsTotal(rows),
      weekLoggedSeconds: realSecondsTotal(rows.filter((r) => r.start >= weekFrom)),
      since,
    };
  }),

  /**
   * For the host API: the hours this user worked each day (their local day, parallel work once),
   * from `since` (epoch ms) on, never before the module started counting.
   * Days with nothing logged are left out.
   */
  historyDaily: use.input(z.object({ moduleId: moduleIdSchema, since: z.number().int().nonnegative().optional() })).query(async ({ ctx, input }) => {
    await requireActive(input.moduleId);
    const db = getDb();
    const from = Math.max(await sinceOf(db, ctx.user.id, input.moduleId), input.since ?? 0);
    const rows = await db
      .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
      .from(worklogs)
      .where(and(eq(worklogs.userId, ctx.user.id), gte(worklogs.started, new Date(from))));
    // The server runs in the user's zone (api/lib/tz.ts): its local days are the user's.
    const days = realSecondsByDay(rows.map((r) => ({ start: r.started, seconds: r.seconds })));
    return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds }));
  }),
});
