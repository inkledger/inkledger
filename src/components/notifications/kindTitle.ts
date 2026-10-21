import { t } from "@/i18n";

/** One line per kind of notification, in the current language. */
export function kindTitle(kind: string): string {
  switch (kind) {
    case "assigned":
      return t("settings.notifications.kinds.assigned");
    case "unassigned":
      return t("settings.notifications.kinds.unassigned");
    case "priority":
      return t("settings.notifications.kinds.priority");
    case "due":
      return t("settings.notifications.kinds.due");
    case "watch_added":
      return t("settings.notifications.kinds.watchAdded");
    case "watch_removed":
      return t("settings.notifications.kinds.watchRemoved");
    case "mentioned":
      return t("settings.notifications.kinds.mentioned");
    case "commented":
      return t("settings.notifications.kinds.commented");
    case "review":
      return t("settings.notifications.kinds.review");
    case "changed":
      return t("settings.notifications.kinds.changed");
    default:
      return t("settings.notifications.kinds.unknown");
  }
}
