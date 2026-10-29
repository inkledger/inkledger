import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { formatDuration } from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import type { Stat } from "@/components/dashboard/QuickStatsCard";

export type EstimateAnswer = inferRouterOutputs<AppRouter>["estimates"]["forIssue"];
export type ShownEstimate = Extract<EstimateAnswer, { none: false }>;

/** How long the issue likely takes (docs/work/ideas/estimates.md): one query, cached by the server until my time changes. */
export function useIssueEstimate(issueKey: string, connectionId: number | null | undefined, enabled: boolean) {
  return trpc.estimates.forIssue.useQuery({ issueKey, ...(connectionId != null ? { connectionId } : {}) }, { enabled, staleTime: 60_000, retry: false });
}

/** The answer when it has a number */
export const shownEstimate = (a: EstimateAnswer | undefined): ShownEstimate | null => (a && "none" in a && !a.none ? a : null);

/** "Likely: 3 h 30 – 5 h", beside the issue's time; nothing until there is a number. */
export function likelyStat(a: EstimateAnswer | undefined): Stat | null {
  const e = shownEstimate(a);
  return e ? { label: t("ui.estimate.likely"), value: `${formatDuration(e.p20)} – ${formatDuration(e.p80)}` } : null;
}
