import { AtSign, CircleDot, Eye, GitPullRequest, MessageSquare, PlayCircle, RefreshCw, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/errorText";
import { plannedOn, putAway } from "@/lib/todoPlan";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { addDays, dayKey } from "@contracts/time";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";

const KIND_ICON = {
  assigned: UserPlus,
  mention: AtSign,
  review: GitPullRequest,
  comment: MessageSquare,
  status: RefreshCw,
  news: CircleDot,
  watched: Eye,
  doing: PlayCircle,
} as const;

/**
 * "Plan today", at the top of Today the first time each day: the late TODOs
 * moved in one go, and what the trackers say could be a TODO (assigned,
 * commented, its status changed, in progress), each made one in a click or
 * put away until tomorrow.
 */
export function PlanToday({ today, late, onChanged }: { today: Date; late: { id: number }[]; onChanged: () => void }) {
  const utils = trpc.useUtils();
  const todayKey = dayKey(today);
  const away = putAway.use();
  const awayToday = away.day === todayKey ? away.sources : [];
  const suggestions = trpc.todos.suggestions.useQuery({ today: todayKey }, { staleTime: 60_000 });
  const shown = (suggestions.data ?? []).filter(s => !awayToday.includes(s.source));
  const done = () => plannedOn.set(todayKey);
  const moveLate = (dueOn: string | null) =>
    void Promise.all(late.map(x => utils.client.todos.update.mutate({ id: x.id, dueOn }))).then(onChanged, toastError);
  const take = (s: (typeof shown)[number], dueOn: string) =>
    void utils.client.todos.add
      .mutate({ text: s.summary, issueKey: s.issueKey, connectionId: s.connectionId, dueOn, source: s.source })
      .then(() => {
        onChanged();
        toast.success(t("views.todos.made", { text: s.summary }));
      }, toastError);
  const putOff = (source: string) => putAway.set({ day: todayKey, sources: [...awayToday, source] });

  return (
    <section aria-label={t("views.todos.planTitle")} {...surface("card")} className="grid gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        {/* Under the page's h1 directly: h2, styled small. */}
        <h2 className="min-w-0 flex-1 text-body-sm font-semibold">{t("views.todos.planTitle")}</h2>
        <Button size="sm" variant="ghost" onClick={done}>
          {t("views.todos.planDone")}
        </Button>
      </div>
      {late.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-body-sm">
          <span className="text-danger">{t("views.todos.planLate", { count: late.length })}</span>
          <Button size="sm" variant="outline" onClick={() => moveLate(todayKey)}>
            {t("views.todos.planLateToday")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => moveLate(dayKey(addDays(today, 1)))}>
            {t("views.todos.planTomorrow")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => moveLate(null)}>
            {t("views.todos.planNone")}
          </Button>
        </div>
      )}
      {shown.length > 0 ? (
        <ul aria-label={t("views.todos.suggested")} className="grid gap-0.5">
          {shown.map(s => {
            const Icon = KIND_ICON[s.kind];
            return (
              <li key={s.source} aria-label={`${s.issueKey} · ${s.summary}`} className="flex items-center gap-2 rounded-md px-1 py-1 text-body-sm hover:bg-accent/50">
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    <span className="font-semibold">{s.issueKey}</span> {s.summary}
                  </span>
                  <span className={cn("block text-caption text-muted-foreground")}>{t(`views.todos.why.${s.kind}`, { status: s.status })}</span>
                </span>
                <Button size="sm" variant="outline" aria-label={t("views.todos.takeToday", { key: s.issueKey })} onClick={() => take(s, todayKey)}>
                  {t("views.todos.planToday")}
                </Button>
                <button
                  type="button"
                  aria-label={t("views.todos.putOff", { key: s.issueKey })}
                  title={t("views.todos.putOff", { key: s.issueKey })}
                  onClick={() => putOff(s.source)}
                  className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        !suggestions.isPending && late.length === 0 && <p className="text-body-sm text-muted-foreground">{t("views.todos.planNothing")}</p>
      )}
    </section>
  );
}
