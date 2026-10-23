import { useState, type ReactNode } from "react";
import { CalendarDays, Flag, Hourglass, Link2, ListChecks, Repeat, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IssuePicker, type IssueRef } from "@/components/app/IssuePicker";
import { visibleIssues } from "@/lib/issues";
import { dayLabel, nextMonday } from "@/lib/todoDay";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { addDays, dayKey, formatDuration } from "@contracts/time";
import { MAX_STEP_TEXT, MAX_TODO_STEPS, TODO_REPEATS, type TodoRepeat, type TodoStep } from "@contracts/todo";
import { t } from "@/i18n";

/**
 * The parts of a TODO beside its text, each a chip that says its value and
 * opens what changes it: the day, the issue, the priority, the estimate, the
 * repeat, the steps. The same in the capture field, on each row and in the
 * "Add a TODO" form, so nothing needs a syntax to learn.
 */

const chip = "inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40";
const quiet = "bg-muted text-muted-foreground";

/** The day: today, tomorrow, next Monday, a day picked, or none. Late shows red. */
export function DayChip({
  dueOn,
  today,
  late = false,
  onPlan,
}: {
  dueOn: string | null;
  today: Date;
  late?: boolean;
  onPlan: (dueOn: string | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  if (picking)
    return (
      <Input
        autoFocus
        type="date"
        aria-label={t("views.todos.pickDay")}
        className="h-7 w-40"
        defaultValue={dueOn ?? dayKey(today)}
        // Kept on Enter or on leaving the field; Esc leaves it as it was.
        onBlur={e => {
          const v = e.currentTarget.value;
          if (v && v !== dueOn) onPlan(v);
          setPicking(false);
        }}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            e.currentTarget.value = dueOn ?? "";
            setPicking(false);
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={dueOn ? t("views.todos.plannedFor", { day: dayLabel(dueOn, today) }) : t("views.todos.plan")}
          className={cn(chip, late ? "bg-danger-soft text-danger" : quiet)}
        >
          <CalendarDays className="h-3 w-3" aria-hidden />
          {dueOn ? dayLabel(dueOn, today) : t("views.todos.noDay")}
          {late && <span className="sr-only"> {t("views.todos.late")}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onPlan(dayKey(today))}>{t("views.todos.planToday")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPlan(dayKey(addDays(today, 1)))}>{t("views.todos.planTomorrow")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPlan(nextMonday(today))}>{t("views.todos.planMonday")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setPicking(true)}>{t("views.todos.planPick")}</DropdownMenuItem>
        {dueOn && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onPlan(null)}>{t("views.todos.planNone")}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The issue: searched by key or title among the user's; removable. */
export function IssueChip({
  value,
  onChange,
  defaultOpen = false,
  onClose,
}: {
  value: IssueRef | null;
  onChange: (pick: IssueRef | null) => void;
  defaultOpen?: boolean;
  /** The search closed, picked or not. */
  onClose?: () => void;
}) {
  const issues = trpc.issues.all.useQuery();
  const list = visibleIssues(issues.data ?? []);
  return (
    <span className="inline-flex max-w-full items-center">
      <IssuePicker issues={list} value={value} onChange={onChange} placeholder={t("views.todos.pickIssue")} defaultOpen={defaultOpen} onOpenChange={o => !o && onClose?.()}>
        <button
          type="button"
          aria-label={value ? t("views.todos.issueSet", { key: value.key }) : t("views.todos.link")}
          className={cn(chip, quiet, value && "text-foreground")}
        >
          <Link2 className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{value ? value.key : t("views.todos.issueChip")}</span>
        </button>
      </IssuePicker>
      {value && <Clear label={t("views.todos.removeToken", { token: value.key })} onClick={() => onChange(null)} />}
    </span>
  );
}

/** High priority, on or off. */
export function PriorityChip({ high, onChange }: { high: boolean; onChange: (high: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={high}
      aria-label={t("views.todos.priority")}
      title={t("views.todos.priority")}
      onClick={() => onChange(!high)}
      className={cn(chip, high ? "bg-primary-soft text-primary-strong" : quiet)}
    >
      <Flag className="h-3 w-3" aria-hidden />
      {high && t("views.todos.priorityShort")}
    </button>
  );
}

/** Estimates offered as they are: the usual lengths, minutes. */
const ESTIMATES = [15, 30, 60, 120, 240].map(m => m * 60);

/** How long it should take. */
export function EstimateChip({ seconds, onChange }: { seconds: number | null; onChange: (seconds: number | null) => void }) {
  return (
    <Menu
      label={seconds ? t("views.todos.estimateSet", { duration: formatDuration(seconds) }) : t("views.todos.estimate")}
      trigger={
        <>
          <Hourglass className="h-3 w-3" aria-hidden />
          {seconds ? formatDuration(seconds) : null}
        </>
      }
      on={seconds !== null}
      value={seconds === null ? "none" : String(seconds)}
      options={[...ESTIMATES.map(s => ({ value: String(s), label: formatDuration(s) })), { value: "none", label: t("views.todos.estimateNone") }]}
      onChange={v => onChange(v === "none" ? null : Number(v))}
    />
  );
}

/** Whether it comes back once ticked. */
export function RepeatChip({ repeat, onChange }: { repeat: TodoRepeat | null; onChange: (repeat: TodoRepeat | null) => void }) {
  return (
    <Menu
      label={repeat ? t("views.todos.repeatSet", { how: t(`views.todos.repeats.${repeat}`) }) : t("views.todos.repeat")}
      trigger={
        <>
          <Repeat className="h-3 w-3" aria-hidden />
          {repeat ? t(`views.todos.repeats.${repeat}`) : null}
        </>
      }
      on={repeat !== null}
      value={repeat ?? "none"}
      options={[...TODO_REPEATS.map(r => ({ value: r, label: t(`views.todos.repeats.${r}`) })), { value: "none", label: t("views.todos.repeatNone") }]}
      onChange={v => onChange(v === "none" ? null : (TODO_REPEATS.find(r => r === v) ?? null))}
    />
  );
}

function Menu({
  label,
  trigger,
  on,
  value,
  options,
  onChange,
}: {
  label: string;
  trigger: ReactNode;
  on: boolean;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={label} title={label} className={cn(chip, quiet, on && "text-foreground")}>
          {trigger}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map(o => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Clear({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="ml-0.5 rounded-sm p-0.5 text-muted-foreground opacity-60 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40">
      <X className="h-3 w-3" aria-hidden />
    </button>
  );
}

/** The steps' count, as a chip that opens them. */
export function StepsChip({ steps, open, onToggle }: { steps: TodoStep[]; open: boolean; onToggle: () => void }) {
  const done = steps.filter(s => s.done).length;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={steps.length ? t("views.todos.stepsProgress", { done, total: steps.length }) : t("views.todos.stepAdd")}
      onClick={onToggle}
      className={cn(chip, quiet, steps.length > 0 && done === steps.length && "text-foreground")}
    >
      <ListChecks className="h-3 w-3" aria-hidden />
      {steps.length > 0 && <span className="tabular">{`${done}/${steps.length}`}</span>}
    </button>
  );
}

/** The steps themselves: ticked, removed, added one by one (Enter). */
export function StepsEditor({ steps, onChange }: { steps: TodoStep[]; onChange: (steps: TodoStep[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim().slice(0, MAX_STEP_TEXT);
    if (!text || steps.length >= MAX_TODO_STEPS) return;
    onChange([...steps, { id: crypto.randomUUID().slice(0, 8), text, done: false }]);
    setDraft("");
  };
  return (
    <ul aria-label={t("views.todos.steps")} className="grid gap-0.5">
      {steps.map(s => (
        <li key={s.id} className="flex items-center gap-2 text-body-sm">
          <Checkbox
            checked={s.done}
            aria-label={t("views.todos.stepTick", { text: s.text })}
            onCheckedChange={v => onChange(steps.map(x => (x.id === s.id ? { ...x, done: v === true } : x)))}
          />
          <span className={cn("min-w-0 flex-1 break-words", s.done && "text-muted-foreground line-through")}>{s.text}</span>
          <Clear label={t("views.todos.stepRemove", { text: s.text })} onClick={() => onChange(steps.filter(x => x.id !== s.id))} />
        </li>
      ))}
      {steps.length < MAX_TODO_STEPS && (
        <li>
          <Input
            aria-label={t("views.todos.stepAdd")}
            placeholder={t("views.todos.stepPlaceholder")}
            className="h-7"
            value={draft}
            maxLength={MAX_STEP_TEXT}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
        </li>
      )}
    </ul>
  );
}
