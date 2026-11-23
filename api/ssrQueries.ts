import type { createServerSideHelpers } from "@trpc/react-query/server";
import type { QueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { AppRouter } from "./router";
import { addDays, dayKey, startOfDay } from "@contracts/time";
import { timers } from "@db/schema";
import { getDb } from "./queries/connection";
import { timerId } from "@contracts/timerSplit";

export type SSRHelpers = ReturnType<typeof createServerSideHelpers<AppRouter>>;

export function supportsSSR(url: URL): boolean {
  if (url.pathname === "/login") return true;
  if (url.pathname !== "/") return false;
  if (url.searchParams.has("from") || url.searchParams.get("modules") === "off") return false;
  return !url.searchParams.get("period") || url.searchParams.get("period") === "day";
}

export async function prefetchSSR(helpers: SSRHelpers, url: URL, mustChangePassword: boolean): Promise<void> {
  if (url.pathname === "/login") {
    await Promise.all([helpers.auth.me.prefetch(), helpers.auth.remembered.prefetch()]);
    return;
  }

  const today = startOfDay(new Date());
  const from = today;
  const to = addDays(from, 1);
  const period = { from: from.toISOString(), to: to.toISOString() };
  const recent = { from: addDays(today, -13).toISOString(), to: to.toISOString() };
  const common = [
    helpers.settings.get.prefetch(),
    helpers.connections.list.prefetch(),
    helpers.issues.favorites.prefetch(),
    helpers.issues.unreadCount.prefetch(),
    helpers.issues.syncStatus.prefetch(),
    helpers.todos.reminders.prefetch({ today: dayKey(today) }),
    helpers.todos.working.prefetch(),
    helpers.outbox.list.prefetch(),
    helpers.modules.list.prefetch(),
    // A question open on another page shows on this one's first paint.
    helpers.decisions.list.prefetch(),
  ];
  if (mustChangePassword) {
    await Promise.all([helpers.auth.me.prefetch(), ...common]);
    return;
  }
  await Promise.all([
    helpers.auth.me.prefetch(),
    helpers.stats.dashboard.prefetch(),
    helpers.issues.all.prefetch(),
    helpers.workSchedule.list.prefetch(),
    helpers.workSchedule.days.prefetch(),
    helpers.worklogs.list.prefetch(period),
    helpers.worklogs.list.prefetch(recent),
    helpers.todos.sessions.prefetch(period),
    helpers.weeks.status.prefetch({ week: dayKey(from) }),
    ...common,
  ]);
  // Only the layouts the user customized: everyone else renders the bundled default, with no query.
  const { workspace } = await helpers.settings.get.fetch(undefined, { staleTime: Infinity });
  await Promise.all(
    SSR_WORKSPACE_SCOPES.filter(scope => workspace.scopes.includes(`${scope.surfaceId}:${scope.deviceClass}`) || workspace.flowMap)
      .map(scope => helpers.workspace.get.prefetch({ scope, clientInstanceId: "ssr" })),
  );
}

/** The scopes the SSR page shows; the server cannot tell a phone, so the Dashboard is there for both. */
const SSR_WORKSPACE_SCOPES = [
  { surfaceId: "dashboard", deviceClass: "desktop" },
  { surfaceId: "dashboard", deviceClass: "mobile" },
  { surfaceId: "shell-desktop", deviceClass: "desktop" },
  { surfaceId: "mobile-tabs", deviceClass: "mobile" },
] as const;

type Outputs = inferRouterOutputs<AppRouter>;
type IssueRef = { issueKey: string; connectionId: number | null };
const ISSUES_ALL = [["issues", "all"], { type: "query" }];

/** The issues of the user's timers: not in the page's state, yet drawn with their summary as soon as they load. */
export async function timerIssuesOf(userId: number): Promise<IssueRef[]> {
  return getDb().select({ issueKey: timers.issueKey, connectionId: timers.connectionId }).from(timers).where(eq(timers.userId, userId));
}

/**
 * The whole issue list is most of the page's state, yet the Dashboard shows only the issues its time is on:
 * those are sent, marked stale, and the browser fetches the rest once it has taken over.
 */
export async function keepIssuesOnScreen(queryClient: QueryClient, more: readonly IssueRef[]): Promise<void> {
  const all = queryClient.getQueryData<Outputs["issues"]["all"]>(ISSUES_ALL);
  if (!all) return;
  // The Dashboard's identity of an issue (src/lib/issues issueId), which the server cannot import.
  const idOf = (connectionId: number | null, key: string) => timerId(connectionId ?? 0, key);
  const shown = new Set(more.map(r => idOf(r.connectionId, r.issueKey)));
  for (const [, logs] of queryClient.getQueriesData<Outputs["worklogs"]["list"]>({ queryKey: [["worklogs", "list"]] }))
    for (const w of logs ?? []) shown.add(idOf(w.connectionId, w.issueKey));
  queryClient.setQueryData(ISSUES_ALL, all.filter(i => shown.has(idOf(i.connectionId, i.key))));
  await queryClient.invalidateQueries({ queryKey: ISSUES_ALL, exact: true, refetchType: "none" });
}
