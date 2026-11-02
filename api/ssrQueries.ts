import type { createServerSideHelpers } from "@trpc/react-query/server";
import type { AppRouter } from "./router";
import { addDays, dayKey, startOfDay } from "@contracts/time";

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
