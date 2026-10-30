import { parseDayKey } from "@contracts/time";
import { dateFormat } from "@/i18n";

/** A note's day ("2026-10-29") as the user reads dates: "29 ott 2026". */
export function noteDay(key: string): string {
  const day = parseDayKey(key);
  return day ? dateFormat({ dateStyle: "medium" }).format(day) : key;
}
