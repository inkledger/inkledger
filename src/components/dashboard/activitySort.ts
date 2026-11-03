import { currentLocale } from "@/i18n";
import type { ActivityRow } from "./ActivityTable";

export type SortKey = "issue" | "last" | "status" | "seconds";

/** Which way each column sorts (what aria-sort says): names A→Z, the most recent and the most hours first. */
export const SORT_DIRECTION: Record<SortKey, "ascending" | "descending"> = { issue: "ascending", status: "ascending", seconds: "descending", last: "descending" };

export function compare(a: ActivityRow, b: ActivityRow, key: SortKey): number {
  switch (key) {
    case "issue":
      return a.issueKey.localeCompare(b.issueKey, currentLocale(), { numeric: true });
    case "status":
      return (a.status ?? "").localeCompare(b.status ?? "", currentLocale());
    case "seconds":
      return b.seconds - a.seconds;
    default:
      return b.lastAt.getTime() - a.lastAt.getTime();
  }
}

