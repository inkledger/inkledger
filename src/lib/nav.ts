import {
  BarChart3,
  CalendarDays,
  Info as InfoIcon,
  KanbanSquare,
  LayoutDashboard,
  ListTodo,
  Settings as SettingsIcon,
} from "lucide-react";
import { t } from "@/i18n";

/**
 * Sidebar navigation; also the source of page breadcrumbs. A function: the
 * labels follow the language when asked for. `group` is the stable id of a
 * group (kept in the folded-sections storage), `title` what is shown.
 */
export function navItems() {
  return [
    {
      group: "main",
      title: t("ui.nav.main"),
      items: [
        { to: "/", label: t("ui.nav.dashboard"), icon: LayoutDashboard },
        { to: "/board", label: t("ui.nav.board"), icon: KanbanSquare },
        { to: "/issues", label: t("ui.nav.issues"), icon: ListTodo },
        { to: "/timesheet", label: t("ui.nav.timesheet"), icon: CalendarDays },
      ],
    },
    {
      group: "analysis",
      title: t("ui.nav.analysis"),
      items: [{ to: "/reports", label: t("ui.nav.reports"), icon: BarChart3 }],
    },
    {
      group: "other",
      title: t("ui.nav.other"),
      items: [
        { to: "/settings", label: t("ui.nav.settings"), icon: SettingsIcon },
        { to: "/info", label: t("ui.nav.info"), icon: InfoIcon },
      ],
    },
  ];
}

/** Phones: the sections in the tab bar; the others are under "More". */
export const TAB_ROUTES: readonly string[] = ["/", "/board", "/issues"];

/** Group title and item of the nav entry matching a pathname (longest prefix). */
export function navEntryFor(pathname: string) {
  let best: { group: string; to: string; label: string } | null = null;
  for (const { title, items } of navItems()) {
    for (const { to, label } of items) {
      const match =
        to === "/"
          ? pathname === "/"
          : pathname === to || pathname.startsWith(`${to}/`);
      if (match && (!best || to.length > best.to.length))
        best = { group: title, to, label };
    }
  }
  return best;
}
