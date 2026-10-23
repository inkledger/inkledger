import { useEffect } from "react";
import { toast } from "sonner";
import { useToday } from "@/hooks/useToday";
import { canShowTodos, showTodos } from "@/hooks/useTodoPanel";
import { deviceSetting } from "@/lib/storage";
import { trpc } from "@/lib/trpc";
import { dayKey } from "@contracts/time";
import { t } from "@/i18n";

/**
 * Today's reminders: open TODOs due today or late, not put away today. Polled
 * like the notifications (the bell counts them with its own).
 */
export function useTodoReminders() {
  const today = dayKey(useToday());
  const q = trpc.todos.reminders.useQuery({ today }, { refetchInterval: 60_000, refetchIntervalInBackground: true });
  return { today, query: q, items: q.data ?? [] };
}

/** The day this device last said "N TODOs for today". */
const told = deviceSetting<string | null>("ikl-todo-reminded-on", raw => raw, v => v);

/** Mount once (AppLayout): the first time in a day there are TODOs due, one toast says so. */
export function useTodoReminderToast() {
  const { today, items } = useTodoReminders();
  const n = items.length;
  useEffect(() => {
    if (n === 0 || told.get() === today) return;
    told.set(today);
    toast.info(t("views.todos.dueToday", { count: n }), canShowTodos() ? { action: { label: t("ui.todoFloat.open"), onClick: () => showTodos() } } : undefined);
  }, [n, today]);
}
