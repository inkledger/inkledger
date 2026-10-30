import { formatDate, formatDuration, parseDayKey } from "@contracts/time";
import { PanelSection } from "@/components/app/Panel";
import { ErrorState } from "@/components/app/States";
import { Chip } from "@/components/app/Chip";
import { Skeleton } from "@/components/ui/skeleton";
import { BandChart, type BandPoint } from "@/components/reports/BandChart";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

const CAPACITY_DAYS = 28;
const hours = (h: number) => formatDuration(h * 3600);
const longDay = (key: string) => formatDate(parseDayKey(key)!, "long");
const shortDay = (key: string) => {
  const d = parseDayKey(key)!;
  return `${d.getDate()}/${d.getMonth() + 1}`;
};

/**
 * When I'll finish and where my times are going (docs/work/ideas/estimates.md R-3.17–R-3.20):
 * absent unless the forecast service is set up and ready (R-3.21).
 */
export function ForecastSections() {
  const available = trpc.forecast.available.useQuery(undefined, { staleTime: 60_000, retry: false });
  if (!available.data?.available) return null;
  return (
    <>
      <PanelSection title={t("pages.reports.forecast.title")} className="border-t">
        <Forecast />
      </PanelSection>
      <PanelSection title={t("pages.reports.forecastTrend.title")} className="border-t">
        <Trend />
      </PanelSection>
    </>
  );
}

function Forecast() {
  const capacity = trpc.forecast.capacity.useQuery({ days: CAPACITY_DAYS }, { staleTime: 10 * 60_000, retry: false });
  const finish = trpc.forecast.finish.useQuery({ scope: "active" }, { staleTime: 10 * 60_000, retry: false });
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 text-body-sm" data-testid="forecast">
      {capacity.isError ? (
        <ErrorState onRetry={() => void capacity.refetch()} />
      ) : !capacity.data ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <BandChart
          caption={t("pages.reports.forecast.capacity")}
          unit={hours}
          points={capacity.data.days.map(
            (d): BandPoint => ({
              key: d.day,
              label: shortDay(d.day),
              title: d.off ? t("pages.reports.forecast.dayOff", { day: longDay(d.day) }) : longDay(d.day),
              p10: d.p10,
              p50: d.p50,
              p90: d.p90,
            }),
          )}
        />
      )}
      {finish.isError ? <ErrorState onRetry={() => void finish.refetch()} /> : !finish.data ? <Skeleton className="h-10 rounded-md" /> : <Finish f={finish.data} />}
    </div>
  );
}

type FinishData = inferRouterOutputs<AppRouter>["forecast"]["finish"];

function Finish({ f }: { f: FinishData }) {
  const scope =
    f.scope.kind === "bucket" ? t("pages.reports.forecast.scopeBucket", { bucket: f.scope.name }) : f.scope.kind === "mine" ? t("pages.reports.forecast.scopeMine") : t("pages.reports.forecast.scopeList");
  // The horizon's last day: "after" it when a date falls beyond.
  const horizonEnd = longDay(addDaysKey(90));
  const count = f.counted;
  const line =
    count === 0
      ? t("pages.reports.forecast.nothing", { scope })
      : f.p50 && f.p80
        ? t("pages.reports.forecast.finish", { count, scope, p50: longDay(f.p50), p80: longDay(f.p80) })
        : f.p50
          ? t("pages.reports.forecast.mixed", { count, scope, p50: longDay(f.p50), date: horizonEnd })
          : t("pages.reports.forecast.beyond", { count, scope, date: horizonEnd });
  return (
    <div className="grid gap-1">
      <p className="font-medium [overflow-wrap:anywhere]">{line}</p>
      {f.unknown > 0 && <p className="text-muted-foreground [overflow-wrap:anywhere]">{t("pages.reports.forecast.unknown", { count: f.unknown })}</p>}
      {f.overKeys.length > 0 && <p className="text-muted-foreground [overflow-wrap:anywhere]">{t("pages.reports.forecast.over", { count: f.overKeys.length })}</p>}
      {count > 0 && <p className="text-caption text-muted-foreground">{t("pages.reports.forecast.bound")}</p>}
    </div>
  );
}

/** Today plus `n` days, as a key. */
function addDaysKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type TrendData = inferRouterOutputs<AppRouter>["forecast"]["trend"];
type TrendSeries = TrendData["work"];

function Trend() {
  const trend = trpc.forecast.trend.useQuery(undefined, { staleTime: 10 * 60_000, retry: false });
  if (trend.isError) return <ErrorState onRetry={() => void trend.refetch()} />;
  if (!trend.data) return <Skeleton className="h-40 rounded-xl" />;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 text-body-sm" data-testid="forecast-trend">
      <TrendChart series={trend.data.work} caption={t("pages.reports.forecastTrend.work")} unit={hours} />
      <TrendChart series={trend.data.ratio} caption={t("pages.reports.forecastTrend.ratio")} unit={v => `×${v.toFixed(2)}`} />
    </div>
  );
}

function TrendChart({ series, caption, unit }: { series: TrendSeries; caption: string; unit: (v: number) => string }) {
  if ("insufficient" in series)
    return (
      <div className="grid gap-1">
        <h3 className="font-medium">{caption}</h3>
        <p className="text-muted-foreground">{t("pages.reports.forecastTrend.insufficient", { need: series.need, have: series.have })}</p>
      </div>
    );
  const points: BandPoint[] = [
    ...series.weeks.map(w => ({
      key: w.week,
      label: shortDay(w.week),
      title: w.imputed ? t("pages.reports.forecastTrend.imputed", { day: longDay(w.week) }) : t("pages.reports.forecastTrend.week", { day: longDay(w.week) }),
      value: w.value,
      imputed: w.imputed,
    })),
    ...series.forecast.map(w => ({
      key: `f${w.week}`,
      label: shortDay(w.week),
      title: t("pages.reports.forecastTrend.ahead", { day: longDay(w.week) }),
      p10: w.p10,
      p50: w.p50,
      p90: w.p90,
    })),
  ];
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{caption}</h3>
        <Chip>{t(`pages.reports.forecastTrend.${series.direction}`)}</Chip>
      </div>
      <BandChart caption={caption} unit={unit} points={points} />
    </div>
  );
}
