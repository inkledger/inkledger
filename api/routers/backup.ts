import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createRouter, permProcedure } from "../middleware";
import { env } from "../lib/env";
import {
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

/** Server-wide: for whoever may manage backups. */
const backups = permProcedure("manageBackups");

const fail = (e: unknown) =>
  new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e instanceof Error ? e.message : String(e) });

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

  update: backups
    .input(backupSettingsSchema.partial())
    .mutation(({ input }) => setBackupSettings(input)),

  run: backups.mutation(async () => {
    try {
      return { name: await runBackup() };
    } catch (e) {
      throw fail(e);
    }
  }),

  restore: backups.input(z.object({ name: z.string().max(100) })).mutation(async ({ input }) => {
    try {
      return await restoreBackup(input.name);
    } catch (e) {
      throw fail(e);
    }
  }),
});
