import { t } from "@contracts/i18n";

export type Schedule = "off" | "hourly" | "daily" | "weekly";

/** Monday first. A function: the names follow the language. */
export function weekdays(): string[] {
  return [
    t("ui.weekday.mon"),
    t("ui.weekday.tue"),
    t("ui.weekday.wed"),
    t("ui.weekday.thu"),
    t("ui.weekday.fri"),
    t("ui.weekday.sat"),
    t("ui.weekday.sun"),
  ];
}

/** Same list, read lazily by index (kept for callers that map over it). */
export const WEEKDAYS: string[] = [];
for (let i = 0; i < 7; i++)
  Object.defineProperty(WEEKDAYS, i, { get: () => weekdays()[i], enumerable: true });

/** "Every day at 02:00" */
export function scheduleLabel(s: { schedule: Schedule; time: string; weekday: number }): string {
  if (s.schedule === "off") return t("ui.schedule.off");
  if (s.schedule === "hourly") return t("ui.schedule.hourly");
  if (s.schedule === "daily") return t("ui.schedule.daily", { time: s.time });
  return t("ui.schedule.weekly", { day: weekdays()[s.weekday - 1] ?? "", time: s.time });
}
