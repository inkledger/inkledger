import { formatDuration } from "@contracts/time";
import { t } from "@/i18n";
import { Chip } from "@/components/app/Chip";
import { ErrorState } from "@/components/app/States";
import { shownEstimate, type useIssueEstimate } from "@/components/issue/estimateQuery";

const CONFIDENCE_TONE = { low: "neutral", medium: "info", high: "success" } as const;

/** What the range rests on, how sure it is, what was left out; "not enough history" without a number; nothing on a closed issue. */
export function EstimateLines({ query, trackerEstimate }: { query: ReturnType<typeof useIssueEstimate>; trackerEstimate: number | null }) {
  const a = query.data;
  if (query.isError) return <ErrorState className="py-4" onRetry={() => void query.refetch()} />;
  if (!a || "hidden" in a) return null;
  const waiting = a.excluded.pending + a.excluded.stale + a.excluded.retry;
  const e = shownEstimate(a);
  return (
    <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-1 text-body-sm text-muted-foreground" data-testid="issue-estimate">
      {e ? (
        <>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
            <span>{t("ui.estimate.basis", { p50: formatDuration(e.p50), n: e.n, basis: t(`ui.estimate.tier.t${e.tier}`) })}</span>
            <Chip tone={CONFIDENCE_TONE[e.confidence]}>{t(`ui.estimate.confidence.${e.confidence}`)}</Chip>
          </p>
          {e.calibration?.calibrated != null && trackerEstimate !== null && (
            <p className="[overflow-wrap:anywhere]">
              {t("ui.estimate.calibrated", {
                estimate: formatDuration(trackerEstimate),
                ratio: e.calibration.ratio.toFixed(2),
                calibrated: formatDuration(e.calibration.calibrated),
              })}
            </p>
          )}
          {e.allWorklogs > 0 && <p className="[overflow-wrap:anywhere]">{t("ui.estimate.allWorklogs", { count: e.allWorklogs })}</p>}
        </>
      ) : (
        <p>{t("ui.estimate.none", { n: a.n })}</p>
      )}
      {waiting > 0 && <p className="[overflow-wrap:anywhere]">{t("ui.estimate.waiting", { count: waiting })}</p>}
    </div>
  );
}
