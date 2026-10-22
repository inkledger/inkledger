import { z } from "zod";
import { BACKDROP_VISIBILITY } from "@contracts/modules";
import { eq } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { settings, type Settings } from "@db/schema";
import { domainInput } from "@contracts/linksSchema";
import {
  normalizeDashboardLayout,
  type DashboardLayoutItem,
} from "@contracts/dashboard";
import { t } from "@contracts/i18n";

const DEFAULTS = {
  dailyTargetSeconds: 8 * 3600,
  weeklyTargetSeconds: 40 * 3600,
  timerAlertMinutes: 120,
  notifyEnabled: 1,
};

export async function getSettings(userId: number): Promise<Settings> {
  const db = getDb();
  const rows = await db.select().from(settings).where(eq(settings.userId, userId));
  if (rows[0]) return rows[0];
  // Parallel first requests race to create the row: the loser just reads it.
  await db
    .insert(settings)
    .values({ userId, ...DEFAULTS })
    .onConflictDoNothing({ target: settings.userId });
  const [created] = await db.select().from(settings).where(eq(settings.userId, userId));
  return created;
}

export type SettingsWithDashboard = Omit<Settings, "allowedLinkDomains"> & {
  dashboard: DashboardLayoutItem[];
  /** Board columns (status names) the user keeps collapsed */
  collapsedColumns: string[];
  /** Domains whose links open without asking */
  allowedLinkDomains: string[];
};

function parseStringList(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function withDashboard(row: Settings): SettingsWithDashboard {
  let saved: unknown = null;
  if (row.dashboardLayout) {
    try {
      saved = JSON.parse(row.dashboardLayout);
    } catch {
      saved = null;
    }
  }
  return {
    ...row,
    dashboard: normalizeDashboardLayout(saved),
    collapsedColumns: parseStringList(row.boardCollapsed),
    allowedLinkDomains: parseStringList(row.allowedLinkDomains),
  };
}

export const settingsRouter = createRouter({
  get: protectedProcedure.query(async ({ ctx }) =>
    withDashboard(await getSettings(ctx.user.id)),
  ),

  update: protectedProcedure
    .input(
      z.object({
        dailyTargetSeconds: z.number().int().min(1800).max(16 * 3600).optional(),
        weeklyTargetSeconds: z.number().int().min(3600).max(80 * 3600).optional(),
        timerAlertMinutes: z.number().int().min(0).max(720).optional(),
        notifyEnabled: z.number().int().min(0).max(1).optional(),
        idleMinutes: z.number().int().min(0).max(240).optional(),
        themeColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, { error: () => t("server.settings.invalidColor") })
          .transform((c) => c.toUpperCase())
          .optional(),
        dashboardLayout: z
          .array(z.object({ id: z.string().min(1), visible: z.boolean() }))
          .max(20)
          .optional(),
        collapsedColumns: z.array(z.string().min(1).max(100)).max(50).optional(),
        allowedLinkDomains: z.array(domainInput).max(200).optional(),
        backdropVisibility: z.enum(BACKDROP_VISIBILITY).optional(),
        overlapPolicy: z.enum(["warn", "block"]).optional(),
        dashboardNight: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await getSettings(ctx.user.id); // ensure row exists
      const { dashboardLayout, collapsedColumns, allowedLinkDomains, dashboardNight, ...rest } = input;
      await db
        .update(settings)
        .set({
          ...rest,
          ...(dashboardNight === undefined ? {} : { dashboardNight: dashboardNight ? 1 : 0 }),
          ...(dashboardLayout
            ? { dashboardLayout: JSON.stringify(dashboardLayout) }
            : {}),
          ...(collapsedColumns
            ? { boardCollapsed: JSON.stringify([...new Set(collapsedColumns)]) }
            : {}),
          ...(allowedLinkDomains
            ? { allowedLinkDomains: JSON.stringify([...new Set(allowedLinkDomains)].sort()) }
            : {}),
        })
        .where(eq(settings.userId, ctx.user.id));
      return withDashboard(await getSettings(ctx.user.id));
    }),
});
