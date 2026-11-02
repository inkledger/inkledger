import { trpc } from "@/lib/trpc";
import { errorText } from "@/lib/errorText";
import { DayTimeline } from "@/components/dashboard/DayTimeline";
import { ErrorState } from "@/components/app/States";
import { Skeleton } from "@/components/ui/skeleton";
import { projectColor } from "@/lib/projectColors";
import type { PlannedEntry } from "@contracts/planned";
import { t } from "@/i18n";

/**
 * Someone's day for the team report: their worklogs on the hour axis, read
 * only, with their schedule; vacation as a bare block (nobody else reads its note).
 */
export function TeamDayBody({ userId, day, dayKey }: { userId: number; day: Date; dayKey: string }) {
  const q = trpc.team.day.useQuery({ userId, day: dayKey });
  if (q.isPending) return <Skeleton className="h-40 rounded-xl" />;
  if (q.error) return <ErrorState message={errorText(q.error)} onRetry={() => void q.refetch()} />;
  const away: PlannedEntry[] = q.data.away.map((a, i) => ({
    id: `away-${i}`,
    userId,
    kind: "vacation",
    startsAt: new Date(a.startsAt),
    endsAt: new Date(a.endsAt),
    note: null,
    connectionId: null,
    itemId: null,
    issueKey: null,
    convertedWorklogId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  return (
    <div className="grid min-w-0 gap-3">
      <DayTimeline
        day={day}
        entries={q.data.entries.map(e => ({ ...e, start: new Date(e.start) }))}
        colorOf={projectColor}
        schedule={q.data.schedule}
        plannedEntries={away}
        readOnly
      />
      {q.data.entries.length === 0 && <p className="text-body-sm text-muted-foreground">{t("pages.team.dayEmpty")}</p>}
    </div>
  );
}
