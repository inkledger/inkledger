import { addDays, dayKey, parseDayKey } from "@contracts/time";
import { dateFormat } from "@contracts/i18n/core";
import { t } from "@/i18n";

/** How a TODO's day reads next to it: today, tomorrow, yesterday, else its weekday and date. */
export function dayLabel(dueOn: string, today: Date): string {
  const key = dayKey(today);
  if (dueOn === key) return t("views.todos.day.today");
  if (dueOn === dayKey(addDays(today, 1))) return t("views.todos.day.tomorrow");
  if (dueOn === dayKey(addDays(today, -1))) return t("views.todos.day.yesterday");
  const d = parseDayKey(dueOn);
  if (!d) return dueOn;
  const sameYear = d.getFullYear() === today.getFullYear();
  return dateFormat({ weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(d);
}

/** The next Monday after `today` (a week on when today is Monday). */
export function nextMonday(today: Date): string {
  const ahead = (8 - today.getDay()) % 7 || 7;
  return dayKey(addDays(today, ahead));
}
