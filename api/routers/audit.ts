// Settings › Audit log: the events, filtered and paged; the chain checked; how long they stay.
// The export (CSV/JSON) is a REST route (api/auditExport.ts): a download streams.
import { z } from "zod";
import { AUDIT_OUTCOMES, AUDIT_RETENTION_DEFAULT_DAYS, AUDIT_RETENTION_MAX_DAYS, AUDIT_RETENTION_MIN_DAYS } from "@contracts/audit";
import { createRouter, permProcedure } from "../middleware";
import { auditRetentionDays, listAudit, RETENTION_KEY, verifyAudit } from "../lib/audit";
import { getServerSetting, setServerSetting } from "../lib/serverSettings";
import { env } from "../lib/env";

const view = permProcedure("viewAudit");

/** What the list and the export filter by (the same fields, the same meaning). */
export const auditFilterInput = z.object({
  actorUserId: z.number().int().positive().optional(),
  /** An action, or a prefix ending in "." (all of "users.") */
  action: z.string().trim().min(1).max(80).optional(),
  targetType: z.string().trim().min(1).max(40).optional(),
  targetId: z.string().trim().min(1).max(80).optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
});

export const auditRouter = createRouter({
  list: view
    .input(auditFilterInput.extend({ cursor: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(({ input: { cursor, limit, ...filters } }) => listAudit(filters, limit, cursor)),

  /** The whole chain walked: an edited or removed row shows here. */
  verify: view.query(() => verifyAudit()),

  /** How long events stay, and whether the file copy is on. */
  settings: view.query(async () => ({
    retentionDays: await auditRetentionDays(),
    stored: await getServerSetting<number | null>(RETENTION_KEY, null),
    defaultDays: AUDIT_RETENTION_DEFAULT_DAYS,
    minDays: AUDIT_RETENTION_MIN_DAYS,
    maxDays: AUDIT_RETENTION_MAX_DAYS,
    fileMirror: env.auditFileMirror,
  })),

  /** A server setting: whoever manages the server sets it (never under the minimum). */
  setRetention: permProcedure("manageRetention")
    .input(z.object({ days: z.number().int().min(AUDIT_RETENTION_MIN_DAYS).max(AUDIT_RETENTION_MAX_DAYS) }))
    .mutation(async ({ input, ctx }) => {
      const before = await auditRetentionDays();
      await setServerSetting(RETENTION_KEY, input.days);
      ctx.audit.set({ target: { type: "server", id: RETENTION_KEY }, before: { days: before }, after: { days: input.days } });
      return { retentionDays: input.days };
    }),
});
