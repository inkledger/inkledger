import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, permProcedure } from "../middleware";
import { env } from "../lib/env";
import { roleOf } from "../queries/accounts";
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

/** The device this request comes from, as remembered (its stored, hashed id), if it is. */
function rememberedDeviceId(req: Request): string | undefined {
  const token = readRememberCookie(req, parseCookies(req.headers.get("cookie")));
  return token ? hashSessionId(token) : undefined;
}

/** Server-wide: for whoever may manage backups. */
const backups = permProcedure("manageBackups");

/**
 * What went wrong, said to whoever manages backups: a name or file that can't be, or the
 * backup tools' own cause (an internal error's words never leave a production server).
 */
const fail = (e: unknown) => {
  // The tools' failures in the server's log too, as every internal error is.
  if (!(e instanceof BackupError)) console.error("[backup]", e);
  return new TRPCError({
    code: e instanceof BackupError ? (e.kind === "invalid" ? "BAD_REQUEST" : e.kind === "busy" ? "CONFLICT" : "NOT_FOUND") : "SERVICE_UNAVAILABLE",
    message: e instanceof Error ? e.message : String(e),
    cause: e,
  });
};

export const backupRouter = createRouter({
  /** Settings → Backup: schedule, state, the folder and its backups. */
  get: backups.query(async () => {
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
    };
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
   * Admins only: the backup's accounts come back with it, so whoever restores could take
   * back an access it no longer has (managing backups is not managing accounts).
   */
  restore: backups.input(z.object({ name: z.string().max(100) })).mutation(async ({ input, ctx }) => {
    if (roleOf(ctx.user) !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: t("server.auth.notAllowed") });
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
