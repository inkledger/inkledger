// The Desk (contracts/desk.ts): the user's current one, issues side by side.
// Stored normalized; read with each pane's key refreshed from the catalogue, so
// an issue renamed (moved to another project) stays on the desk under its new key.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { desks, issues, itemAliases } from "@db/schema";
import { addPane, deskIssues, DESK_MAX_PANES, isIssue, normalizeDesk, paneId, type DeskLayout, type DeskPane, type DeskSlot } from "@contracts/desk";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issueConnection } from "../providers/connections";
import { issueKeyInput } from "../lib/inputs";

async function readCurrent(userId: number): Promise<DeskLayout> {
  const [row] = await getDb()
    .select({ layout: desks.layout })
    .from(desks)
    .where(and(eq(desks.userId, userId), isNull(desks.name)))
    .limit(1);
  if (!row) return normalizeDesk(null);
  try {
    return normalizeDesk(JSON.parse(row.layout));
  } catch {
    return normalizeDesk(null);
  }
}

async function writeCurrent(userId: number, layout: DeskLayout): Promise<DeskLayout> {
  const desk = normalizeDesk(layout);
  const now = new Date();
  await getDb()
    .insert(desks)
    .values({ userId, name: null, layout: JSON.stringify(desk), createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: desks.userId, targetWhere: isNull(desks.name), set: { layout: JSON.stringify(desk), updatedAt: now } });
  return desk;
}

/** Each pane under its issue's key today, found by its identity on its connection (empty slots stay as they are). */
async function refreshKeys(userId: number, desk: DeskLayout): Promise<DeskLayout> {
  const all = [...deskIssues(desk), ...desk.parked];
  const ids = all.filter(pane => pane.remoteId !== null);
  if (!ids.length) return desk;
  const rows = await getDb()
    .select({ connectionId: issues.connectionId, remoteId: issues.remoteId, key: issues.key })
    .from(issues)
    .where(and(eq(issues.userId, userId), inArray(issues.remoteId, ids.map(pane => pane.remoteId ?? ""))));
  const keyOf = new Map(rows.map(row => [`${row.connectionId}:${row.remoteId}`, row.key]));
  let changed = false;
  const fresh = <T extends DeskSlot>(pane: T): T => {
    if (!isIssue(pane)) return pane;
    const key = pane.remoteId === null ? undefined : keyOf.get(`${pane.connectionId}:${pane.remoteId}`);
    if (!key || key === pane.key) return pane;
    changed = true;
    return { ...pane, key };
  };
  const panes = desk.panes.map(fresh);
  const parked = desk.parked.map(fresh);
  if (!changed) return desk;
  const renamed = new Map(desk.panes.map((pane, i) => [paneId(pane), paneId(panes[i])]));
  return normalizeDesk({ ...desk, panes, parked, maximized: desk.maximized ? (renamed.get(desk.maximized) ?? desk.maximized) : null });
}

/** The issue as a pane: its identity on its connection (null when the catalogue doesn't have it), under its key today. */
async function paneFor(userId: number, key: string, connectionId: number | undefined): Promise<DeskPane> {
  const connection = await issueConnection(userId, key, connectionId);
  const db = getDb();
  const pick = { remoteId: issues.remoteId, key: issues.key };
  const [byKey] = await db
    .select(pick)
    .from(issues)
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, connection.id), eq(issues.key, key)))
    .limit(1);
  // An old key (the issue moved since): the issue it names now.
  const [byAlias] = byKey
    ? []
    : await db
        .select(pick)
        .from(itemAliases)
        .innerJoin(issues, eq(issues.id, itemAliases.itemId))
        .where(and(eq(issues.userId, userId), eq(issues.connectionId, connection.id), eq(itemAliases.key, key)))
        .orderBy(desc(itemAliases.createdAt))
        .limit(1);
  const found = byKey ?? byAlias;
  return { connectionId: connection.id, key: found?.key ?? key, remoteId: found?.remoteId ?? null };
}

/** The issue with this identity on one of the user's connections, as a pane (its link names it so). */
async function paneByRef(userId: number, connectionId: number, remoteId: string): Promise<DeskPane> {
  const [row] = await getDb()
    .select({ key: issues.key })
    .from(issues)
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, connectionId), eq(issues.remoteId, remoteId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return { connectionId, key: row.key, remoteId };
}

export const desksRouter = createRouter({
  /** The current desk (empty until something is put on it). */
  current: protectedProcedure.query(async ({ ctx }) => {
    const stored = await readCurrent(ctx.user.id);
    const desk = await refreshKeys(ctx.user.id, stored);
    if (desk !== stored) await writeCurrent(ctx.user.id, desk);
    return desk;
  }),

  /** The desk as the page has it now (made safe first). */
  setCurrent: protectedProcedure
    .input(z.object({ layout: z.unknown() }))
    .mutation(async ({ ctx, input }) => writeCurrent(ctx.user.id, normalizeDesk(input.layout))),

  /**
   * Puts an issue on the desk, by its key or by its identity (an issue link): already there,
   * nothing changes; the first empty slot takes it; a full desk parks its last pane (`parked`
   * names it). `key`: the issue's key today.
   */
  add: protectedProcedure
    .input(
      z.union([
        z.object({ connectionId: z.number().int().positive().optional(), key: issueKeyInput }),
        z.object({ connectionId: z.number().int().positive(), remoteId: z.string().min(1).max(200) }),
      ])
    )
    .mutation(async ({ ctx, input }) => {
      const pane = "remoteId" in input ? await paneByRef(ctx.user.id, input.connectionId, input.remoteId) : await paneFor(ctx.user.id, input.key, input.connectionId);
      const before = await readCurrent(ctx.user.id);
      const already = before.panes.some(item => paneId(item) === paneId(pane));
      const full = before.panes.length >= DESK_MAX_PANES && before.panes.every(isIssue) && !already;
      const out = full ? before.panes[before.panes.length - 1] : undefined;
      const layout = already ? before : await writeCurrent(ctx.user.id, addPane(before, pane));
      return { layout, key: pane.key, already, full, parked: out && isIssue(out) ? out.key : undefined, count: deskIssues(layout).length };
    }),
});
