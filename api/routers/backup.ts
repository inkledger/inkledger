import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, permProcedure } from "../middleware";
import { env } from "../lib/env";
import { can } from "../queries/accounts";
import { parseCookies } from "../context";
import { readRememberCookie } from "../lib/session";
import { hashSessionId } from "../lib/security";
import { t } from "@contracts/i18n";
import {
  BackupError,
  backupDir,
  backupDirWritable,
  backupSettingsSchema,
  getBackupSettings,
  getBackupState,
  listBackups,
  nextRun,
  restoreBackup,
  runBackup,
  setBackupSettings,
} from "../backup";
import { fetchOffsite, getOffsite, getOffsiteState, listOffsite, offsiteSettingsSchema, OffsiteError, resticConfigured, setOffsite, uploadNewest } from "../backupOffsite";
import { backupKeySet } from "../backupCrypto";
import { drillAudit, getDrillSettings, getLastDrill, runDrill, setDrillSettings } from "../backupDrill";
import { UnsafeUrlError } from "../lib/security";

/** The device this request comes from, as remembered (its stored, hashed id), if it is. */
function rememberedDeviceId(req: Request): string | undefined {
  const token = readRememberCookie(req, parseCookies(req.headers.get("cookie")));
  return token ? hashSessionId(token) : undefined;
}

/** Server-wide: for whoever may run backups (and set their schedule). */
const backups = permProcedure("runBackups");

/** Restoring one: restoreBackups, and an owner besides (see restore). */
const restoring = permProcedure("restoreBackups");

/**
 * What went wrong, said to whoever manages backups: a name or file that can't be, or the
 * backup tools' own cause (an internal error's words never leave a production server).
 */
const fail = (e: unknown) => {
  if (e instanceof TRPCError) return e;
  // The tools' failures in the server's log too, as every internal error is.
  if (!(e instanceof BackupError) && !(e instanceof OffsiteError)) console.error("[backup]", e);
  const code =
    e instanceof BackupError || e instanceof OffsiteError
      ? e.kind === "invalid"
        ? "BAD_REQUEST"
        : e.kind === "busy"
          ? "CONFLICT"
          : "NOT_FOUND"
      : e instanceof UnsafeUrlError
        ? "BAD_REQUEST"
        : "SERVICE_UNAVAILABLE";
  return new TRPCError({
    code,
    message: e instanceof Error ? e.message : String(e),
    cause: e,
  });
};

export const backupRouter = createRouter({
  /** Settings → Backup: schedule, state, the folder and its backups. */
  get: backups.query(async ({ ctx }) => {
    const settings = await getBackupSettings();
    return {
      settings,
      state: await getBackupState(),
      dir: backupDir(),
      writable: backupDirWritable(),
      /** The schedule runs in the installed server (container), not in dev. */
      scheduled: env.isProduction,
      next: env.isProduction ? (nextRun(settings, new Date())?.getTime() ?? null) : null,
      files: listBackups(),
      /** Whether this account may take a dump off the server (GET /api/backups/:name, downloadBackups) */
      canDownload: can(ctx.user, "downloadBackups"),
      /** Whether this account may restore one (an owner with restoreBackups) */
      canRestore: ctx.user.access.owner && can(ctx.user, "restoreBackups"),
      /** Off-site copies: where (never the secret), how the last one went, what the server's environment allows */
      offsite: await getOffsite(),
      offsiteState: await getOffsiteState(),
      backupKeySet: backupKeySet(),
      resticConfigured: resticConfigured(),
      drill: await getLastDrill(),
      drillSettings: await getDrillSettings(),
    };
  }),

  /** Where off-site copies go. The secret is sealed and never comes back; the audit says only whether one is set. */
  offsiteUpdate: backups.input(offsiteSettingsSchema.partial().extend({ secret: z.string().max(500).optional() })).mutation(async ({ input, ctx }) => {
    const before = await getOffsite();
    try {
      const after = await setOffsite(input);
      ctx.audit.set({ target: { type: "server", id: "backup.offsite" }, before, after });
      return after;
    } catch (e) {
      throw fail(e);
    }
  }),

  /** The newest backup copied off-site now (the same path as after each backup). */
  offsiteUpload: backups.mutation(async ({ ctx }) => {
    const newest = listBackups()[0]?.name;
    ctx.audit.set({ target: { type: "backup", id: newest ?? "" }, after: { name: newest ?? null } });
    try {
      const state = await uploadNewest(newest);
      if (!state) throw new OffsiteError("invalid", "No off-site copies are set up.");
      if (state.lastName !== newest || (state.lastErrorAt ?? 0) > (state.lastOkAt ?? 0)) {
        ctx.audit.set({ after: { name: newest, lastError: state.lastError }, outcome: "failed" });
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: state.lastError ?? "" });
      }
      ctx.audit.set({ after: { name: newest, lastOkAt: state.lastOkAt } });
      return { name: newest };
    } catch (e) {
      throw fail(e);
    }
  }),

  /** The copies off-site (asked for: it calls the bucket or the repository). */
  offsiteList: backups.query(async () => {
    try {
      return await listOffsite();
    } catch (e) {
      throw fail(e);
    }
  }),

  /**
   * An off-site copy brought back (downloaded, decrypted, verified) and restored by the
   * same path as a saved one. Owners with restoreBackups only, like restore.
   */
  offsiteRestore: restoring.input(z.object({ name: z.string().max(100) })).mutation(async ({ input, ctx }) => {
    if (!ctx.user.access.owner) throw new TRPCError({ code: "FORBIDDEN", message: t("server.auth.notAllowed") });
    ctx.audit.set({ target: { type: "backup", id: input.name }, after: { name: input.name } });
    try {
      const got = await fetchOffsite(input.name);
      const keep = ctx.sessionId && ctx.user.username ? { id: ctx.sessionId, userId: ctx.user.id, username: ctx.user.username, deviceId: rememberedDeviceId(ctx.req) } : undefined;
      const done = await restoreBackup(got.name, { keepSession: keep, by: { userId: ctx.user.id, label: ctx.user.username ?? ctx.user.displayName } });
      ctx.audit.set({ action: "restore.completed", after: { name: got.name, safety: done.safety, preRestoreLastHash: done.preRestoreLastHash } });
      return { safety: done.safety, data: got.data };
    } catch (e) {
      throw fail(e);
    }
  }),

  /** A restore drill now: the newest backup into the scratch database, checked, dropped. */
  drill: backups.mutation(async ({ ctx }) => {
    const result = await runDrill();
    ctx.audit.set({ target: { type: "backup", id: result.dump ?? "" }, after: drillAudit(result, false) });
    // A failed drill is an error to whoever asked (recorded, alerted and shown in Settings all the same).
    if (!result.ok) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: result.error ?? "" });
    return result;
  }),

  drillUpdate: backups.input(z.object({ weekly: z.boolean() })).mutation(async ({ input, ctx }) => {
    const before = await getDrillSettings();
    const after = await setDrillSettings(input);
    ctx.audit.set({ target: { type: "server", id: "backup.drill" }, before, after });
    return after;
  }),

  update: backups.input(backupSettingsSchema.partial()).mutation(async ({ input, ctx }) => {
    const before = await getBackupSettings();
    const after = await setBackupSettings(input);
    ctx.audit.set({ target: { type: "server", id: "backup" }, before, after });
    return after;
  }),

  run: backups.mutation(async ({ ctx }) => {
    try {
      const name = await runBackup();
      ctx.audit.set({ target: { type: "backup", id: name }, after: { name } });
      return { name };
    } catch (e) {
      throw fail(e);
    }
  }),

  /**
   * Owners only: the backup's accounts come back with it, so whoever restores could take
   * back an access it no longer has (running backups is not managing accounts).
   */
  restore: restoring.input(z.object({ name: z.string().max(100) })).mutation(async ({ input, ctx }) => {
    if (!ctx.user.access.owner) throw new TRPCError({ code: "FORBIDDEN", message: t("server.auth.notAllowed") });
    ctx.audit.set({ target: { type: "backup", id: input.name }, after: { name: input.name } });
    try {
      const keep = ctx.sessionId && ctx.user.username ? { id: ctx.sessionId, userId: ctx.user.id, username: ctx.user.username, deviceId: rememberedDeviceId(ctx.req) } : undefined;
      const done = await restoreBackup(input.name, { keepSession: keep, by: { userId: ctx.user.id, label: ctx.user.username ?? ctx.user.displayName } });
      // The log is the backup's now: its first event after the restore says what came before.
      ctx.audit.set({ action: "restore.completed", after: { name: input.name, safety: done.safety, preRestoreLastHash: done.preRestoreLastHash } });
      return { safety: done.safety };
    } catch (e) {
      throw fail(e);
    }
  }),
});
