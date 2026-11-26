import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { trpc } from "@/lib/trpc";
import { relativeFormat, t } from "@/i18n";

export type AlertRow = inferRouterOutputs<AppRouter>["notifications"]["alerts"][number];

/** What an alert says, in the reader's language. */
export function alertMessage(a: Pick<AlertRow, "alert" | "name" | "count"> & { what?: string | null }): string {
  const count = a.count ?? 0;
  switch (a.alert) {
    case "auth_failed":
      return t("settings.notifications.alert.auth_failed", { name: a.name });
    case "unreadable":
      return t("settings.notifications.alert.unreadable", { name: a.name });
    case "unreachable":
      return t("settings.notifications.alert.unreachable", { name: a.name });
    case "failures":
      return t("settings.notifications.alert.failures", { name: a.name, count });
    case "backup":
      return t("settings.notifications.alert.backup");
    case "offsite":
      return t("settings.notifications.alert.offsite");
    case "drill":
      return t("settings.notifications.alert.drill", { name: a.name });
    case "licence":
      return t("settings.notifications.alert.licence", { name: a.name });
    case "certificate":
      return count <= 0 ? t("settings.notifications.alert.certificateExpired") : t("settings.notifications.alert.certificate", { count });
    case "feedback":
      return a.what === "comment" ? t("settings.notifications.alert.feedbackComment", { name: a.name }) : t("settings.notifications.alert.feedbackStatus", { name: a.name });
  }
}

/** Where an alert is dealt with. */
export function alertPath(a: Pick<AlertRow, "alert" | "ref">): string {
  switch (a.alert) {
    case "feedback":
      return a.ref ? `/feedback/${a.ref}` : "/feedback";
    case "backup":
    case "offsite":
    case "drill":
      return "/settings/backup";
    case "licence":
      return "/settings/store";
    case "certificate":
      return "/settings/network";
    default:
      return "/settings/connections";
  }
}

export function alertAgo(date: Date): string {
  const min = Math.round((date.getTime() - Date.now()) / 60_000);
  if (Math.abs(min) < 1) return t("settings.notifications.now");
  const relative = relativeFormat();
  if (Math.abs(min) < 60) return relative.format(min, "minute");
  const h = Math.round(min / 60);
  return Math.abs(h) < 24 ? relative.format(h, "hour") : relative.format(Math.round(h / 24), "day");
}

/** The account's alerts, polled like the notification count. */
export function useAlerts() {
  return trpc.notifications.alerts.useQuery(undefined, { refetchInterval: 60_000, refetchIntervalInBackground: true });
}

