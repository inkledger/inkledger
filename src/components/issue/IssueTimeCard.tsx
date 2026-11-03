import { formatDate, formatDuration, parseDayKey } from "@contracts/time";
import { PanelSection } from "@/components/app/Panel";
import { StatStrip } from "@/components/app/StatStrip";
import { EstimateLines } from "@/components/issue/IssueEstimate";
import { likelyStat } from "@/components/issue/estimateQuery";
import type { Issue, IssueData } from "@/components/issue/useIssueData";
import { t } from "@/i18n";

/** Time on the issue: mine, the estimate and progress on it, the team's total and the due day. */
export function IssueTimeCard({
  issue: i,
  data: { offers, timeHere, team, estimateQuery },
  logTotal,
  logCount,
}: {
  issue: Issue;
  data: IssueData;
  /** My time on it, once my worklogs are read. */
  logTotal: number | undefined;
  /** Its worklogs shown (mine and the others'). */
  logCount: number;
}) {
  const due = i.dueDate ? parseDayKey(i.dueDate) : null;
  // The tracker's total counts everyone: mine first, the team's beside it.
  const teamTotal = timeHere ? null : (team.data?.totalSeconds ?? i.timeSpentSeconds ?? 0);
  // The estimate is the whole issue's: progress on everyone's time.
  const spent = teamTotal ?? logTotal ?? 0;
  const estimate = i.timeEstimateSeconds ?? 0;
  // An estimate only where the tracker keeps one and this issue has it.
  const hasEstimate = offers.estimate && i.timeEstimateSeconds != null;
  const pct =
    estimate > 0 ? Math.min(100, Math.round((spent / estimate) * 100)) : null;
  return (
    <PanelSection className="order-2 border-b" title={t("pages.issueDetail.timeOnIssue")}>
      {/* The issue's time in figures, three to a row in this column: mine, the estimate, the team's, the due day. */}
      <StatStrip
        label={t("pages.issueDetail.timeOnIssue")}
        variant="compact"
        maxColumns={3}
        className="-mx-5 border-t md:-mx-6"
        items={[
          { label: t("pages.issueDetail.myTime"), value: logTotal !== undefined ? formatDuration(logTotal) : "—" },
          ...(hasEstimate ? [{ label: t("pages.issueDetail.estimate"), value: formatDuration(estimate) }] : []),
          ...[likelyStat(estimateQuery.data)].filter(s => s !== null),
          ...(hasEstimate ? [{ label: t("pages.issueDetail.progress"), value: pct !== null ? `${pct}%` : "—", ...(pct !== null ? { meter: { value: spent, max: estimate, label: t("pages.issueDetail.progress") } } : {}) }] : []),
          { label: t("pages.issueDetail.worklogs"), value: String(logCount) },
          ...(teamTotal === null ? [] : [{ label: t("pages.issueDetail.teamTotal"), value: formatDuration(teamTotal) }]),
          { label: t("pages.issueDetail.due"), value: due ? formatDate(due, "long") : "—" },
        ]}
      />
      <EstimateLines query={estimateQuery} trackerEstimate={i.timeEstimateSeconds ?? null} />
    </PanelSection>
  );
}
