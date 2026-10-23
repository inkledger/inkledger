import { Link } from "react-router";
import { toast } from "sonner";
import { PanelSection } from "@/components/app/Panel";
import { surface } from "@/components/app/surface";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { canShowTodos, showTodos } from "@/hooks/useTodoPanel";
import { useToday } from "@/hooks/useToday";
import { toastError } from "@/lib/errorText";
import { issuePath } from "@/lib/issues";
import { dayLabel } from "@/lib/todoDay";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { dayKey } from "@contracts/time";
import { t } from "@/i18n";

/** The Dashboard's "To do today": today's TODOs and the late ones, ticked from here; nothing when there are none. */
export function TodayTodosCard() {
  const utils = trpc.useUtils();
  const today = useToday();
  const todayKey = dayKey(today);
  const list = trpc.todos.list.useQuery({ view: "today", today: todayKey });
  const items = list.data ?? [];
  if (items.length === 0) return null;
  const tick = (id: number, text: string) =>
    void utils.client.todos.update.mutate({ id, done: true }).then(() => {
      void utils.todos.invalidate();
      toast.success(t("views.todos.ticked", { text }), {
        action: { label: t("views.todos.undo"), onClick: () => void utils.client.todos.update.mutate({ id, done: false }).then(() => utils.todos.invalidate(), toastError) },
      });
    }, toastError);
  return (
    <PanelSection
      title={
        <span className="flex min-w-0 items-center gap-2">
          {t("views.todos.remindersTitle")}
          <span {...surface("chip")} className="rounded-full bg-primary-soft px-2 text-caption font-semibold text-primary-strong tabular">
            {items.length}
          </span>
        </span>
      }
      className="border-b"
      actions={
        canShowTodos() && (
          <Button variant="ghost" size="sm" onClick={() => showTodos()}>
            {t("views.todos.openList")}
          </Button>
        )
      }
    >
      <ul aria-label={t("views.todos.remindersTitle")} className="grid gap-1 md:grid-cols-2 2xl:grid-cols-3">
        {items.map(x => {
          const late = !!x.dueOn && x.dueOn < todayKey;
          return (
            <li key={x.id} aria-label={x.text} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50">
              <Checkbox className="mt-0.5" checked={false} aria-label={t("views.todos.tick", { text: x.text })} onCheckedChange={() => tick(x.id, x.text)} />
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="break-words text-body-sm">{x.text}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
                  {late && x.dueOn && <span className={cn("text-danger")}>{dayLabel(x.dueOn, today)}</span>}
                  {x.issueKey && (
                    <Link to={issuePath({ key: x.issueKey, connectionId: x.connectionId })} className="truncate hover:text-foreground">
                      {x.summary ? `${x.issueKey} · ${x.summary}` : x.issueKey}
                    </Link>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </PanelSection>
  );
}
