import { Meter } from "@/components/app/Meter";
import { ErrorState } from "@/components/app/States";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

/** How the estimates would have done on my issues of the last 90 days (docs/work/ideas/estimates.md R-3.16): coverage, typical error, how many. */
export function EstimateAccuracy() {
  const accuracy = trpc.estimates.accuracy.useQuery(undefined, { staleTime: 5 * 60_000, retry: false });
  const a = accuracy.data;
  if (accuracy.isError) return <ErrorState onRetry={() => void accuracy.refetch()} />;
  if (!a) return <Skeleton className="h-16 rounded-xl" />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2 text-body-sm" data-testid="estimate-accuracy">
      {a.coverage !== null && a.mdape !== null && (
        <>
          <Meter value={a.coverage} max={100} size="md" label={t("pages.reports.accuracy.title")} />
          <p className="[overflow-wrap:anywhere]">{t("pages.reports.accuracy.body", { coverage: Math.round(a.coverage), mdape: Math.round(a.mdape), n: a.n })}</p>
        </>
      )}
      {a.skipped > 0 && <p className="text-muted-foreground [overflow-wrap:anywhere]">{t("pages.reports.accuracy.skipped", { count: a.skipped })}</p>}
    </div>
  );
}
