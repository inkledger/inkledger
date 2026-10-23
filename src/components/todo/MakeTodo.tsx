import { useState } from "react";
import { ListChecks } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { EstimateChip, PriorityChip, RepeatChip } from "@/components/todo/TodoChips";
import { canShowTodos, showTodos } from "@/hooks/useTodoPanel";
import { useToday } from "@/hooks/useToday";
import { toastError } from "@/lib/errorText";
import { nextMonday } from "@/lib/todoDay";
import { trpc } from "@/lib/trpc";
import { makeTodo } from "@/lib/makeTodo";
import { cn } from "@/lib/utils";
import { addDays, dayKey } from "@contracts/time";
import type { TodoRepeat } from "@contracts/todo";
import { t } from "@/i18n";

/** What a new TODO hangs on: an issue, one of its comments, or one of the user's private notes on it. */
export type TodoLink = { issueKey: string; connectionId?: number; commentId?: string; commentExcerpt?: string; issueNoteId?: number };

type When = "today" | "tomorrow" | "monday" | "none";

/**
 * A TODO from here: its text (prefilled from what it comes from), its day
 * (today unless changed), saved tied to the issue, comment or note.
 */
function MakeTodoForm({ link, initial, onDone }: { link: TodoLink; initial: string; onDone: () => void }) {
  const utils = trpc.useUtils();
  const today = useToday();
  const [text, setText] = useState(initial);
  const [when, setWhen] = useState<When>("today");
  const [high, setHigh] = useState(false);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [repeat, setRepeat] = useState<TodoRepeat | null>(null);
  const [busy, setBusy] = useState(false);
  const dueOn = { today: dayKey(today), tomorrow: dayKey(addDays(today, 1)), monday: nextMonday(today), none: null }[when];
  const save = () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    void utils.client.todos.add
      .mutate({ text: v, dueOn, ...link, priority: high ? 1 : 0, estimateSeconds: estimate, repeat })
      .then(() => {
        void utils.todos.invalidate();
        onDone();
        toast.success(t("views.todos.made", { text: v }), canShowTodos() ? { action: { label: t("ui.todoFloat.open"), onClick: () => showTodos() } } : undefined);
      }, toastError)
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="grid gap-3"
      onSubmit={e => {
        e.preventDefault();
        save();
      }}
    >
      <Input autoFocus aria-label={t("views.todos.captureLabel")} value={text} maxLength={500} onChange={e => setText(e.target.value)} />
      <SegmentedControl<When>
        label={t("views.todos.plan")}
        value={when}
        onChange={setWhen}
        options={[
          { value: "today", label: t("views.todos.planToday") },
          { value: "tomorrow", label: t("views.todos.planTomorrow") },
          { value: "monday", label: t("views.todos.planMondayShort") },
          { value: "none", label: t("views.todos.planNone") },
        ]}
      />
      <div role="group" aria-label={t("views.todos.captureDetails")} className="flex flex-wrap items-center gap-1 text-caption">
        <PriorityChip high={high} onChange={setHigh} />
        <EstimateChip seconds={estimate} onChange={setEstimate} />
        <RepeatChip repeat={repeat} onChange={setRepeat} />
      </div>
      <Button type="submit" size="sm" disabled={busy || !text.trim()}>
        {t("views.todos.add")}
      </Button>
    </form>
  );
}

/**
 * "TODO" next to a comment, a note or an issue's title: a small form to make
 * one from it. With `count` (TODOs already made from it) it says so.
 */
export function MakeTodoButton({ link, initial, count = 0, label, className }: { link: TodoLink; initial: string; count?: number; label: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={count ? `${label} (${t("views.todos.already", { count })})` : label} title={label} className={cn(count > 0 && "text-primary-strong", className)}>
          <ListChecks className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{count ? t("views.todos.badge", { count }) : t("views.todos.short")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {open && <MakeTodoForm link={link} initial={initial} onDone={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

/** The same form in a dialog: from a menu item (a card's, a row's), where nothing stays to anchor a popover. */
export function MakeTodoDialog({ link, initial, open, onOpenChange }: { link: TodoLink; initial: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("views.todos.makeTitle", { key: link.issueKey })}</DialogTitle>
          <DialogDescription>{t("views.todos.makeHint")}</DialogDescription>
        </DialogHeader>
        {open && <MakeTodoForm link={link} initial={initial} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** The app's one "Add a TODO…" dialog, for the menus that ask through makeTodo. */
export function MakeTodoHost() {
  const asked = makeTodo.use();
  return asked ? <MakeTodoDialog link={asked.link} initial={asked.initial} open onOpenChange={o => !o && makeTodo.close()} /> : null;
}
