import { parseDayKey } from "@contracts/time";
import { mediumDate } from "@/lib/dates";

/** A note's day ("2026-10-29") as the user reads dates: "29 ott 2026". */
export function noteDay(key: string): string {
  const day = parseDayKey(key);
  return day ? mediumDate(day) : key;
}
