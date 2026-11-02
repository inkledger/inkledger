import { trpc } from "@/lib/trpc";
import { errorText } from "@/lib/errorText";
import { BELOW } from "@contracts/team";
import { formatDurationLong } from "@contracts/time";
import { Chip } from "@/components/app/Chip";
import { Meter } from "@/components/app/Meter";
import { ErrorState } from "@/components/app/States";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { Delta } from "./TeamMatrix";
import { TeamCalendar } from "./TeamCalendar";
import { percent, type Person } from "./model";

/** A ranked list of names and hours, each with its share of the first. */
function Ranked({ title, rows }: { title: string; rows: { key: string; label: string; seconds: number }[] }) {
  const most = Math.max(1, ...rows.map(r => r.seconds));
  return (
    <section className="grid gap-2">
      <h3 className="text-body-sm font-medium">{title}</h3>
      <ul className="grid gap-2">
        {rows.map(r => (
          <li key={r.key} className="grid min-w-0 gap-1">
            <div className="flex min-w-0 items-baseline justify-between gap-3 text-body-sm">
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="shrink-0 tabular text-muted-foreground">{formatDurationLong(r.seconds)}</span>
            </div>
            <Meter value={r.seconds} max={most} tone="bg-chart-focus" size="xs" />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One person's period beside the matrix: hours against target and the
 * change, day by day, where the hours went (projects, issues: names only,
 * not links: they aren't the viewer's), and the days below target.
 */
export function TeamPersonPanel({
  person,
  from,
  to,
  today,
  note,
  delta,
  onDay,
}: {
  person: Person;
  from: string;
  to: string;
  today: string;
  note: string | null;
  delta: number | null;
  onDay: (day: Date) => void;
}) {
  const q = trpc.team.person.useQuery({ userId: person.userId, from, to });
  const below = person.days.filter(d => d.day <= today && d.targetSeconds > 0 && d.loggedSeconds < d.targetSeconds * BELOW);
  return (
    <div className="grid min-w-0 gap-5 overflow-y-auto p-5">
      <SheetHeader className="p-0">
        <SheetTitle className="font-display text-title">{person.displayName}</SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-2">
          <span className="tabular">
            {person.coverage === null
              ? t("pages.team.panelNoTarget", { logged: formatDurationLong(person.loggedSeconds) })
              : t("pages.team.panelPeriod", { logged: formatDurationLong(person.loggedSeconds), target: formatDurationLong(person.targetSeconds), percent: percent(person.coverage) })}
          </span>
          <Delta value={delta} />
          {note && (
            <span title={t("pages.team.freshHint")}>
              <Chip tone="warning">{note}</Chip>
            </span>
          )}
        </SheetDescription>
      </SheetHeader>
      <TeamCalendar person={person} from={from} to={to} today={today} onDay={onDay} />
      {q.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : q.error ? (
        <ErrorState message={errorText(q.error)} onRetry={() => void q.refetch()} />
      ) : q.data.issues.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t("pages.team.nothingYet")}</p>
      ) : (
        <>
          <Ranked title={t("pages.team.projects")} rows={q.data.projects.map(p => ({ key: p.key, label: p.name ? `${p.key} — ${p.name}` : p.key, seconds: p.seconds }))} />
          <Ranked title={t("pages.team.issues")} rows={q.data.issues.map(i => ({ key: i.key, label: i.summary ? `${i.key} — ${i.summary}` : i.key, seconds: i.seconds }))} />
        </>
      )}
      <p className="text-body-sm text-muted-foreground">
        {below.length === 0 ? t("pages.team.noneBelow") : t("pages.team.daysBelowCount", { count: below.length })}
      </p>
    </div>
  );
}
