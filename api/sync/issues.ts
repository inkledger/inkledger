// The issue stream of a connection, for any tracker through the provider
// contract: its pass read page by page into the catalogue, what its service
// reports gone marked (never deleted here), transfers followed with the
// time and notes that hang on the issue, and in a full pass the issues no
// longer among the user's asked one by one: still there, or missing.
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { issueNotes, issues, itemAliases, notifications, outbox, pinboardNotes, timers, todos, worklogs } from "@db/schema";
import type { StatusCategory } from "@contracts/providers";
import { getDb } from "../queries/connection";
import { ensureContainer } from "../queries/containers";
import type { BoundTracker } from "../providers/core/bind";
import type { CallMeta } from "../providers/core/context";
import { eachPage } from "../providers/core/paging";
import type { Checkpoint, IssueGone, IssueRef, RemoteIssue, ReportedIssueGone } from "../providers/types";
import type { Budget } from "./budget";

/** The catalogue's status grouping (until categories get their own column, WP-14). */
const GROUP: Record<StatusCategory, string> = {
  triage: "To Do",
  backlog: "To Do",
  todo: "To Do",
  doing: "In Progress",
  done: "Done",
  cancelled: "Done",
};

type Target = { userId: number; connectionId: number };

/** A catalogue row's fields for an issue from any tracker (its identity apart). */
export function fieldsOf(i: RemoteIssue) {
  const assignee = i.assignees[0];
  return {
    key: i.key,
    summary: i.title,
    status: i.status.name,
    statusId: i.status.id,
    statusCategory: GROUP[i.status.category],
    category: i.status.category,
    priorityRank: i.priority?.rank ?? null,
    projectKey: i.container.key,
    projectName: i.container.name,
    issueType: i.type.name,
    priority: i.priority?.name ?? "",
    labels: JSON.stringify(i.labels),
    components: JSON.stringify(i.components ?? []),
    assigneeId: assignee?.remoteId ?? "",
    assigneeName: assignee?.name ?? "",
    reporterName: i.reporter?.name ?? "",
    timeEstimateSeconds: i.estimateSeconds ?? null,
    timeSpentSeconds: i.spentSeconds ?? null,
    dueDate: i.due ?? null,
    remoteUpdatedAt: i.updatedAt ?? null,
    remoteCreatedAt: i.createdAt ?? null,
    statusChangedAt: i.statusChangedAt ?? null,
    projectAvatarUrl: i.container.avatarUrl ?? null,
    url: i.url,
    goneAt: null,
    goneReason: null,
    syncedAt: new Date(),
  };
}

/** The issue in the catalogue, by its identity on the connection (a new key follows it: the database keeps the old as an alias). */
export async function upsertRemote(t: Target, i: RemoteIssue): Promise<number> {
  const set = { ...fieldsOf(i), containerId: await ensureContainer(t.connectionId, i.container) };
  const [saved] = await getDb()
    .insert(issues)
    .values({ userId: t.userId, connectionId: t.connectionId, remoteId: i.remoteId, ...set })
    .onConflictDoUpdate({ target: [issues.userId, issues.connectionId, issues.remoteId], set })
    .returning({ id: issues.id });
  return saved.id;
}

async function markGone(t: Target, remoteIds: string[], reason: IssueGone["reason"], at = new Date()) {
  if (remoteIds.length === 0) return;
  await getDb()
    .update(issues)
    .set({ goneAt: at, goneReason: reason })
    .where(and(eq(issues.userId, t.userId), eq(issues.connectionId, t.connectionId), inArray(issues.remoteId, remoteIds), isNull(issues.goneAt)));
}

/**
 * What hung on an issue that moved to a new identity (its time, notes,
 * timers, post-its, notifications, queued changes) now hangs on its
 * successor; the old key stays an alias of it. A table where the successor
 * already has its own (one note per issue) keeps the old row on the old issue.
 */
async function moveDependents(from: { id: number; key: string }, to: { id: number; key: string }) {
  const db = getDb();
  for (const table of [worklogs, timers, outbox, issueNotes, pinboardNotes, notifications, todos]) {
    try {
      await db.update(table).set({ itemId: to.id, issueKey: to.key }).where(eq(table.itemId, from.id));
    } catch (e) {
      console.warn(`[sync] transfer ${from.key} → ${to.key}: kept on the old issue (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  await db.insert(itemAliases).values({ itemId: to.id, key: from.key }).onConflictDoNothing();
}

async function followTransfer(b: BoundTracker, t: Target, meta: CallMeta, budget: Budget, gone: Extract<ReportedIssueGone, { reason: "transferred" }>) {
  const db = getDb();
  const [old] = await db
    .select({ id: issues.id, key: issues.key })
    .from(issues)
    .where(and(eq(issues.userId, t.userId), eq(issues.connectionId, t.connectionId), eq(issues.remoteId, gone.remoteId)))
    .limit(1);
  if (!old) return;
  let [next] = await db
    .select({ id: issues.id, key: issues.key })
    .from(issues)
    .where(and(eq(issues.userId, t.userId), eq(issues.connectionId, t.connectionId), eq(issues.remoteId, gone.successor.remoteId)))
    .limit(1);
  if (!next) {
    await budget.take(meta.signal);
    const remote = await b.getIssue(meta, gone.successor);
    if (remote) next = { id: await upsertRemote(t, remote), key: remote.key };
  }
  if (next) await moveDependents(old, next);
}

export type IssuePassResult = { checkpoint: Checkpoint | null; seen: number; gone: number; missing: number };

/**
 * One pass of the issue stream: from the checkpoint (null: everything, a
 * full pass), applied page by page. Only a full pass reconciles.
 */
export async function syncIssues(b: BoundTracker, t: Target, opts: { since: Checkpoint | null; meta: CallMeta; budget: Budget }): Promise<IssuePassResult> {
  const { meta, budget } = opts;
  const seen = new Set<string>();
  let goneCount = 0;
  const { checkpoint } = await eachPage(
    async (q) => {
      await budget.take(meta.signal);
      return b.listChanged(meta, q);
    },
    opts.since,
    async (items, gone) => {
      for (const i of items) {
        await upsertRemote(t, i);
        seen.add(i.remoteId);
      }
      for (const g of gone) {
        if (g.reason === "transferred") await followTransfer(b, t, meta, budget, g);
        await markGone(t, [g.remoteId], g.reason);
        goneCount++;
      }
    },
  );
  const missing = opts.since === null ? await reconcile(b, t, seen, meta, budget) : 0;
  // A full pass also lists every container the account sees: a bucket can pick one with no issue yet.
  if (opts.since === null && b.containers) {
    await budget.take(meta.signal);
    for (const c of await b.containers(meta)) await ensureContainer(t.connectionId, c);
  }
  return { checkpoint, seen: seen.size, gone: goneCount, missing };
}

/**
 * After a full pass: the catalogue's issues it didn't list are no longer the
 * user's. Each is asked for: still there (refreshed), or missing, which is
 * only a doubt: kept, marked, never treated as deleted.
 */
async function reconcile(b: BoundTracker, t: Target, seen: Set<string>, meta: CallMeta, budget: Budget): Promise<number> {
  const rest = await getDb()
    .select({ remoteId: issues.remoteId, key: issues.key, container: issues.projectKey })
    .from(issues)
    .where(
      and(
        eq(issues.userId, t.userId),
        eq(issues.connectionId, t.connectionId),
        isNull(issues.goneAt),
        seen.size ? notInArray(issues.remoteId, [...seen]) : sql`true`,
      ),
    );
  let missing = 0;
  for (const r of rest) {
    await budget.take(meta.signal);
    const ref: IssueRef = { remoteId: r.remoteId, key: r.key };
    const remote = await b.getIssue(meta, ref);
    if (remote) await upsertRemote(t, remote);
    else {
      await markGone(t, [r.remoteId], "missing");
      missing++;
    }
  }
  return missing;
}
