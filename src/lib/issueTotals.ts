import type { IssueTotal } from "@/components/dashboard/PeriodSummary";
import { issueId } from "@/lib/issues";

/** The issues with the most time in these worklogs (at most `limit`), with their summary where known. */
export function topIssueTotals(
  logs: readonly { issueKey: string; connectionId?: number | null; timeSpentSeconds: number }[],
  infoOf: ReadonlyMap<string, { summary?: string; remoteId?: string | null }>,
  limit = 5
): IssueTotal[] {
  const totals = new Map<string, IssueTotal>();
  for (const w of logs) {
    const id = issueId(w);
    const entry = totals.get(id) ?? { issueKey: w.issueKey, connectionId: w.connectionId, seconds: 0 };
    entry.seconds += w.timeSpentSeconds;
    totals.set(id, entry);
  }
  return [...totals.values()]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit)
    .map(total => {
      const info = infoOf.get(issueId(total));
      return { ...total, summary: info?.summary, remoteId: info?.remoteId };
    });
}
