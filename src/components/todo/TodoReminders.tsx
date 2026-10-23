import { Link } from "react-router";
import { CalendarDays, Check, EyeOff, ListChecks } from "lucide-react";
import { SectionLabel } from "@/components/app/PageHeader";
import { Button } from "@/components/ui/button";
import { surface } from "@/components/app/surface";
import { canShowTodos, showTodos } from "@/hooks/useTodoPanel";
import { useTodoReminders } from "@/hooks/useTodoReminders";
import { useToday } from "@/hooks/useToday";
import { toastError } from "@/lib/errorText";
import { issuePath } from "@/lib/issues";
import { dayLabel } from "@/lib/todoDay";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { addDays, dayKey } from "@contracts/time";
import { t } from "@/i18n";

/**
 * The notification center's "To do today": each TODO due today or late, done
 * from here, moved to tomorrow, opened, or put away until tomorrow.
 */
export function TodoReminders({ onOpen }: { onOpen: () => void }) {
  const utils = trpc.useUtils();
  const today = useToday();
  const { today: todayKey, items } = useTodoReminders();
  if (items.length === 0) return null;
  const refresh = () => utils.todos.invalidate();
  const act = (p: Promise<unknown>) => void p.then(refresh, toastError);
  return (
    <section aria-label={t("views.todos.remindersTitle")}>
      <SectionLabel as="h3" className="mb-2 px-2">
        {t("views.todos.remindersTitle")} ({items.length})
      </SectionLabel>
      <ul className="grid gap-2">
        {items.map(x => {
          const late = !!x.dueOn && x.dueOn < todayKey;
          return (
            <li key={x.id} {...surface("card")} aria-label={x.text} className="grid gap-1.5 rounded-xl border bg-card px-3 py-2.5 shadow-xs">
              <div className="flex items-start gap-2">
                <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <p className="min-w-0 flex-1 break-words text-body-sm">{x.text}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1 text-caption">
                {x.dueOn && (
                  <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5", late ? "bg-danger-soft text-danger" : "bg-muted text-muted-foreground")}>
                    <CalendarDays className="h-3 w-3" aria-hidden />
                    {dayLabel(x.dueOn, today)}
                  </span>
                )}
                {x.issueKey && (
                  <Link to={issuePath({ key: x.issueKey, connectionId: x.connectionId })} onClick={onOpen} className="truncate rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground hover:text-foreground">
                    {x.summary ? `${x.issueKey} · ${x.summary}` : x.issueKey}
                  </Link>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="ghost" onClick={() => act(utils.client.todos.update.mutate({ id: x.id, done: true }))}>
                  <Check className="h-3.5 w-3.5" /> {t("views.todos.remindDone")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => act(utils.client.todos.update.mutate({ id: x.id, dueOn: dayKey(addDays(today, 1)) }))}>
                  {t("views.todos.remindTomorrow")}
                </Button>
                {canShowTodos() && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onOpen();
                      showTodos();
                    }}
                  >
                    {t("ui.todoFloat.open")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  aria-label={t("views.todos.remindHideLabel", { text: x.text })}
                  title={t("views.todos.remindHide")}
                  onClick={() => act(utils.client.todos.dismissReminder.mutate({ id: x.id, today: todayKey }))}
                >
                  <EyeOff className="h-3.5 w-3.5" /> {t("views.todos.remindHide")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
