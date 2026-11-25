import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { env } from "../lib/env";
import { parseStringList } from "../lib/json";
import { BACKDROP_VISIBILITY } from "@contracts/modules";
import { THEME_CONTRASTS, THEME_VARIANTS } from "@contracts/theme";
import { eq, sql } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { settings, type Settings } from "@db/schema";
import { domainInput } from "@contracts/linksSchema";
import {
  normalizeDashboardLayout,
  type DashboardLayoutItem,
} from "@contracts/dashboard";
import { t } from "@contracts/i18n";
import { record } from "../lib/audit";
import { isAgentCommand } from "@contracts/analyze";
import { customizedScopes } from "../workspace/store";
import { getFlowSettings } from "../workspace/flowStore";

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

/** What settings.get and settings.update return: the row, plus which workspace runtime the user needs. */
async function settingsView(userId: number) {
  const [row, scopes, flow] = await Promise.all([getSettings(userId), customizedScopes(userId), getFlowSettings(userId)]);
  // Who never customized a layout nor turned FlowMap on runs none of the workspace runtime.
  return { ...withDashboard(row), workspace: { scopes, flowMap: flow.enabled } };
}

/** Settings that change as the pages are arranged: never an audit event. */
const QUIET_SETTINGS = new Set(["dashboardLayout", "collapsedColumns"]);

export const settingsRouter = createRouter({
  get: protectedProcedure.query(({ ctx }) => settingsView(ctx.user.id)),

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
        themeVariant: z.enum(THEME_VARIANTS).optional(),
        themeContrast: z.enum(THEME_CONTRASTS).optional(),
        dashboardLayout: z
          .array(z.object({ id: z.string().min(1), visible: z.boolean() }))
          .max(20)
          .optional(),
        collapsedColumns: z.array(z.string().min(1).max(100)).max(50).optional(),
        allowedLinkDomains: z.array(domainInput).max(200).optional(),
        backdropVisibility: z.enum(BACKDROP_VISIBILITY).optional(),
        overlapPolicy: z.enum(["warn", "block"]).optional(),
        dashboardNight: z.boolean().optional(),
        pinboardOnBoard: z.boolean().optional(),
        pinboardInMenu: z.boolean().optional(),
        pinboardWidget: z.boolean().optional(),
        todosInMenu: z.boolean().optional(),
        todosWidget: z.boolean().optional(),
        todosHotCorner: z.boolean().optional(),
        shareLinkMinutes: z.number().int().min(5).max(1440).optional(),
        /** "Analyse": the coding agent to start (a program and its options, nothing chained) */
        agentCommand: z.string().trim().max(200).refine(isAgentCommand, { message: t("server.projectPaths.badCommand") }).optional(),
        mailCopies: z.enum(["off", "body", "full"]).optional(),
        /** Given in the consent dialog, the first time copies are turned on (docs/work/ideas/mail-copies.md R-1.2) */
        mailCopiesConsent: z.literal(true).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const current = await getSettings(ctx.user.id); // ensure row exists
      const { dashboardLayout, collapsedColumns, allowedLinkDomains, dashboardNight, pinboardOnBoard, pinboardInMenu, pinboardWidget, todosInMenu, todosWidget, todosHotCorner, mailCopiesConsent, ...rest } = input;
      // Copies of mails: never against the server's switch, never without consent once given (R-1.1, R-1.2).
      if (input.mailCopies !== undefined && input.mailCopies !== "off") {
        if (!env.mailCopies) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.mails.copy.off") });
        if (!current.mailCopiesConsentAt && !mailCopiesConsent) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.mails.copy.consent") });
      }
      const consentAt = mailCopiesConsent && !current.mailCopiesConsentAt ? { mailCopiesConsentAt: new Date() } : {};
      const flag = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);
      await db
        .update(settings)
        .set({
          ...rest,
          ...consentAt,
          ...(dashboardNight === undefined ? {} : { dashboardNight: dashboardNight ? 1 : 0 }),
          ...(pinboardOnBoard === undefined ? {} : { pinboardOnBoard: pinboardOnBoard ? 1 : 0 }),
          ...(pinboardInMenu === undefined ? {} : { pinboardInMenu: pinboardInMenu ? 1 : 0 }),
          ...(pinboardWidget === undefined ? {} : { pinboardWidget: pinboardWidget ? 1 : 0 }),
          ...(todosInMenu === undefined ? {} : { todosInMenu: flag(todosInMenu) }),
          ...(todosWidget === undefined ? {} : { todosWidget: flag(todosWidget) }),
          ...(todosHotCorner === undefined ? {} : { todosHotCorner: flag(todosHotCorner) }),
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
      const view = await settingsView(ctx.user.id);
      // What changed, in the fields asked about; a board's layout and folded columns are no event.
      const was: Record<string, unknown> = withDashboard(current);
      const now: Record<string, unknown> = view;
      const changed = Object.keys(input).filter((k) => !QUIET_SETTINGS.has(k) && JSON.stringify(was[k]) !== JSON.stringify(now[k]));
      if (changed.length > 0) {
        await record(ctx, "settings.update", {
          target: { type: "settings", id: ctx.user.id, ownerUserId: ctx.user.id },
          before: Object.fromEntries(changed.map((k) => [k, was[k]])),
          after: Object.fromEntries(changed.map((k) => [k, now[k]])),
        });
      }
      return view;
    }),

  /** Every attachment link copied for an agent so far stops working (docs/work/ideas/issue-copy.md R-6.5). */
  revokeShareLinks: protectedProcedure.mutation(async ({ ctx }) => {
    await getSettings(ctx.user.id);
    await getDb()
      .update(settings)
      .set({ shareLinkGeneration: sql`${settings.shareLinkGeneration} + 1` })
      .where(eq(settings.userId, ctx.user.id));
    await record(ctx, "settings.revokeShareLinks", { target: { type: "settings", id: ctx.user.id, ownerUserId: ctx.user.id } });
    return { ok: true as const };
  }),
});
