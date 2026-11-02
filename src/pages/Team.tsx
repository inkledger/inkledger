import { useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { errorText } from "@/lib/errorText";
import { useAuth } from "@/hooks/useAuth";
import { useToday } from "@/hooks/useToday";
import { useUrlFields } from "@/hooks/useUrlState";
import { oneOf, text, type Fields } from "@/lib/urlCodecs";
import { activePreset, presetRange, type PresetId } from "@/lib/reportLabel";
import { initials, relativeTime } from "@/lib/initials";
import { addDays, dayKey, formatDurationLong, parseDayKey } from "@contracts/time";
import { PageHeader } from "@/components/app/PageHeader";
import { PanelRow, PanelSection } from "@/components/app/Panel";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { Chip } from "@/components/app/Chip";
import { Meter } from "@/components/app/Meter";
import { EmptyState, ErrorState } from "@/components/app/States";
import { lazyPart } from "@/components/app/lazyPart";
import { surface, surfaceFace } from "@/components/app/surface";
import { PeriodPicker } from "@/components/reports/PeriodPicker";
import { PeriodBars, type DayStack } from "@/components/dashboard/PeriodBars";
import { QuickStatsCard } from "@/components/dashboard/QuickStatsCard";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { dateFormat, t } from "@/i18n";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";

const TeamDayBody = lazyPart(() => import("@/components/team/TeamDayBody").then(m => m.TeamDayBody));

type Person = inferRouterOutputs<AppRouter>["team"]["overview"]["people"][number];
type Sort = "hours" | "coverage";

/** Same cap as the server (team.overview reads a report's range). */
const REPORT_MAX_DAYS = 366;

const CHART_COLOR = () => ({ fill: "bg-chart-focus", soft: "", solid: "", stroke: "" });

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** What to warn about an account's time, or null when it can be trusted. */
function freshnessNote(p: Person, now: number): string | null {
  const { state, at } = p.freshness;
  if (state === "reconnect") return t("pages.team.freshReconnect");
  if (state === "never") return t("pages.team.freshNever");
  if (state === "stale" && at !== null) return t("pages.team.freshStale", { date: relativeTime(new Date(at), now) });
  return null;
}

function PersonName({ person, now }: { person: Person; now: number }) {
  const note = freshnessNote(person, now);
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span {...surface("picture", { role: "wrap" })} className="shrink-0 rounded-full">
        <Avatar {...surfaceFace()} className="h-8 w-8">
          <AvatarFallback className="bg-primary-soft text-caption font-semibold text-primary-strong">
            {initials(person.displayName)}
          </AvatarFallback>
        </Avatar>
      </span>
      <div className="min-w-0">
        <p className="truncate text-body-sm font-medium">{person.displayName}</p>
        {note && (
          <span title={t("pages.team.freshHint")}>
            <Chip tone="warning">{note}</Chip>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The team report (viewTeamTime): everyone's logged hours over a period,
 * ranked, against each one's own schedule, and day by day; a day opens
 * that person's timeline, read only.
 */
export default function Team() {
  const today = useToday();
  const now = today.getTime();
  const { user } = useAuth();
  const allowed = user?.permissions.includes("viewTeamTime") ?? false;
  const utils = trpc.useUtils();

  // Period and order live in the URL (Back finds them).
  const fields = useMemo(
    (): Fields<{ from: string; to: string; sort: Sort }> => ({
      from: { key: "from", fallback: dayKey(presetRange("month", today).from), codec: text },
      to: { key: "to", fallback: dayKey(presetRange("month", today).to), codec: text },
      sort: { key: "sort", fallback: "hours", codec: oneOf(["hours", "coverage"] as const) },
    }),
    [today]
  );
  const [shown, setShown] = useUrlFields(fields);
  const { from, to, sort } = shown;
  const fromDate = parseDayKey(from);
  const toDate = parseDayKey(to);
  const ordered = fromDate !== null && toDate !== null && from <= to;
  const tooLong = ordered && addDays(fromDate, REPORT_MAX_DAYS) <= toDate;
  const rangeValid = ordered && !tooLong;

  const overview = trpc.team.overview.useQuery(
    { from, to },
    { enabled: allowed && rangeValid, placeholderData: keepPreviousData }
  );
  // Taken away meanwhile: the menu learns it too.
  const forbidden = overview.error?.data?.code === "FORBIDDEN";
  useEffect(() => {
    if (forbidden) void utils.auth.me.invalidate();
  }, [forbidden, utils]);

  const [open, setOpen] = useState<{ person: Person; day: Date } | null>(null);

  const people = useMemo(() => {
    const list = [...(overview.data?.people ?? [])];
    if (sort === "coverage") {
      // Nothing expected goes last: no share to rank by.
      list.sort((a, b) => (b.coverage ?? -1) - (a.coverage ?? -1) || b.loggedSeconds - a.loggedSeconds);
    }
    return list;
  }, [overview.data, sort]);

  const preset = activePreset(from, to, today);
  const header = (
    <PageHeader
      sticky
      title={t("pages.team.title")}
      description={t("pages.team.description")}
      actions={
        allowed ? (
          <PeriodPicker
            from={from}
            to={to}
            preset={preset}
            valid={rangeValid}
            onPreset={(id: PresetId) => {
              const r = presetRange(id, today);
              setShown({ from: dayKey(r.from), to: dayKey(r.to) });
            }}
            onFrom={v => setShown({ from: v })}
            onTo={v => setShown({ to: v })}
          />
        ) : undefined
      }
    />
  );

  if (!allowed || forbidden) {
    return (
      <>
        {header}
        <PanelSection>
          <EmptyState icon={Lock} title={t("pages.team.notAllowedTitle")} message={t("pages.team.notAllowedMessage")} />
        </PanelSection>
      </>
    );
  }

  if (!rangeValid) {
    return (
      <>
        {header}
        <PanelSection>
          <p role="alert" className="text-body-sm text-danger">
            {tooLong ? t("pages.reports.rangeTooLong", { max: REPORT_MAX_DAYS }) : t("pages.reports.rangeInvalid")}
          </p>
        </PanelSection>
      </>
    );
  }

  if (overview.error) {
    return (
      <>
        {header}
        <PanelSection>
          <ErrorState message={errorText(overview.error)} onRetry={() => void overview.refetch()} />
        </PanelSection>
      </>
    );
  }

  const data = overview.data;
  if (data && data.loggedSeconds === 0) {
    return (
      <>
        {header}
        <PanelSection>
          <EmptyState art="chart" title={t("pages.team.emptyTitle")} message={t("pages.team.emptyMessage")} />
        </PanelSection>
      </>
    );
  }

  const best = Math.max(1, ...people.map(p => (sort === "coverage" ? p.coverage ?? 0 : p.loggedSeconds)));
  const toCheck = people.filter(p => freshnessNote(p, now) !== null).length;
  const stacksOf = (p: Person): DayStack[] =>
    p.days.map(d => ({ day: parseDayKey(d.day) ?? today, parts: [{ project: "_", seconds: d.loggedSeconds }] }));
  const targetsOf = (p: Person) => {
    const byDay = new Map(p.days.map(d => [d.day, d.targetSeconds]));
    return (day: Date) => byDay.get(dayKey(day)) ?? 0;
  };
  const dense = (data?.people[0]?.days.length ?? 0) > 10;

  return (
    <>
      {header}
      <PanelRow className="xl:grid-cols-[minmax(0,1fr)_340px]">
        <PanelSection
          title={t("pages.team.leaderboard")}
          actions={
            <SegmentedControl
              label={t("pages.team.sortLabel")}
              value={sort}
              onChange={v => setShown({ sort: v })}
              options={[
                { value: "hours", label: t("pages.team.sortHours") },
                { value: "coverage", label: t("pages.team.sortCoverage") },
              ]}
            />
          }
        >
          {!data ? (
            <Skeleton className="h-48 rounded-xl" />
          ) : (
            <ol aria-label={t("pages.team.leaderboard")} aria-busy={overview.isPlaceholderData} className={cn("grid gap-1 transition-opacity", overview.isPlaceholderData && "opacity-60")}>
              {people.map((p, i) => (
                <li
                  key={p.userId}
                  className="grid min-h-touch grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 border-b py-2 last:border-b-0 sm:grid-cols-[1.5rem_minmax(0,14rem)_minmax(0,1fr)_auto]"
                >
                  <span className="text-body-sm font-semibold text-muted-foreground tabular">{i + 1}</span>
                  <PersonName person={p} now={now} />
                  <Meter
                    className="max-sm:hidden"
                    value={sort === "coverage" ? p.coverage ?? 0 : p.loggedSeconds}
                    max={best}
                    tone="bg-chart-focus"
                    size="md"
                  />
                  <div className="text-right">
                    <p className="text-body-sm font-semibold tabular">
                      {sort === "coverage" && p.coverage !== null ? percent(p.coverage) : formatDurationLong(p.loggedSeconds)}
                    </p>
                    <p className="text-caption text-muted-foreground tabular">
                      {p.targetSeconds > 0
                        ? sort === "coverage"
                          ? formatDurationLong(p.loggedSeconds)
                          : t("pages.team.ofTarget", { logged: percent(p.coverage ?? 0), target: formatDurationLong(p.targetSeconds) })
                        : t("pages.team.noTarget")}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-caption text-muted-foreground">{t("pages.team.limits")}</p>
        </PanelSection>
        <div className="min-w-0 p-5 md:p-6 xl:pl-0">
          {!data ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : (
            <QuickStatsCard
              title={t("pages.team.title")}
              stats={[
                { label: t("pages.team.logged"), value: formatDurationLong(data.loggedSeconds) },
                { label: t("pages.team.target"), value: formatDurationLong(data.targetSeconds) },
              ]}
              extra={[
                { label: t("pages.team.coverage"), value: data.targetSeconds > 0 ? percent(data.loggedSeconds / data.targetSeconds) : "—" },
                { label: t("pages.team.people"), value: String(people.length) },
                ...(toCheck > 0 ? [{ label: t("pages.team.toCheck"), value: String(toCheck), tone: "danger" as const }] : []),
              ]}
            />
          )}
        </div>
      </PanelRow>
      <PanelSection title={t("pages.team.timelines")}>
        {!data ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : (
          <ul aria-label={t("pages.team.timelines")} className="grid gap-5">
            {people.map(p => (
              <li key={p.userId} className="grid min-w-0 gap-2">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <PersonName person={p} now={now} />
                  <p className="shrink-0 text-body-sm tabular">
                    <span className="font-semibold">{formatDurationLong(p.loggedSeconds)}</span>
                    {p.coverage !== null && <span className="text-muted-foreground"> · {percent(p.coverage)}</span>}
                  </p>
                </div>
                {/* A long range scrolls inside its own strip, never the page. */}
                <div className="overflow-x-auto">
                  <div className={cn(dense && "min-w-[36rem]")}>
                    <PeriodBars
                      stacks={stacksOf(p)}
                      colorOf={CHART_COLOR}
                      targetFor={targetsOf(p)}
                      dense={dense}
                      compact
                      onDay={day => setOpen({ person: p, day })}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
      <Dialog open={open !== null} onOpenChange={o => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-3xl">
          {open && (() => {
            const key = dayKey(open.day);
            const d = open.person.days.find(x => x.day === key);
            return (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {t("pages.team.dayTitle", {
                      name: open.person.displayName,
                      date: dateFormat({ weekday: "long", day: "numeric", month: "long" }).format(open.day),
                    })}
                  </DialogTitle>
                  <DialogDescription>
                    {t("pages.team.dayDescription", {
                      logged: formatDurationLong(d?.loggedSeconds ?? 0),
                      target: formatDurationLong(d?.targetSeconds ?? 0),
                    })}
                  </DialogDescription>
                </DialogHeader>
                <TeamDayBody userId={open.person.userId} day={open.day} dayKey={key} />
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </>
  );
}
