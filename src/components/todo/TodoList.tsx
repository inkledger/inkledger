import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  CalendarCheck,
  Flag,
  Hourglass,
  Link2,
  ListChecks,
  Mail,
  MailPlus,
  MessageSquare,
  MoreHorizontal,
  NotebookPen,
  Pin,
  Play,
  Repeat,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { ExternalLink } from "@/components/app/ExternalLink";
import { PinMailDialog } from "@/components/mail/PinMailDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DayChip,
  EstimateChip,
  IssueChip,
  PriorityChip,
  RepeatChip,
  SpentChip,
  LikelyChip,
  StepsChip,
  StepsEditor,
} from "@/components/todo/TodoChips";
import type { IssueRef } from "@/components/app/IssuePicker";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { useToday } from "@/hooks/useToday";
import { useTodoWork, useTodoWorking } from "@/hooks/useTodoWork";
import { Button } from "@/components/ui/button";
import { PlanToday } from "@/components/todo/PlanToday";
import { ActionRow } from "@/components/app/ActionRow";
import { replanToday, usePlannedToday } from "@/lib/todoPlan";
import { usePinIssue, usePinTodo } from "@/hooks/usePinIssue";
import { toastError } from "@/lib/errorText";
import { issuePath } from "@/lib/issues";
import { dayLabel } from "@/lib/todoDay";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { addDays, dayKey, formatDuration } from "@contracts/time";
import {
  TODO_REPEATS,
  parseSteps,
  parseTodoInput,
  type TodoRepeat,
  type TodoStep,
} from "@contracts/todo";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { t, useLocale } from "@/i18n";

type View = "today" | "upcoming" | "someday" | "done";
type Todo = inferRouterOutputs<AppRouter>["todos"]["list"][number];
/** The list of one issue (its page): its open TODOs, captured already tied to it. */
type Scope = { issueKey: string; connectionId: number };

/**
 * The TODO list: quick capture at the top ("@domani", "#APP-12"), then the
 * day's, the upcoming, the someday and the done ones; each ticked, planned,
 * rewritten, tied to an issue or deleted in place, by mouse or by keys
 * (j/k, x, e, 1/2/0, Delete, Alt+↑/↓). With `scope`, one issue's TODOs.
 */
export function TodoList({
  className,
  scope,
}: {
  className?: string;
  scope?: Scope;
}) {
  const utils = trpc.useUtils();
  const today = useToday();
  const todayKey = dayKey(today);
  const lang = useLocale() === "it" ? "it" : "en";
  const [view, setView] = useState<View>("today");
  const counts = trpc.todos.counts.useQuery(
    { today: todayKey },
    { enabled: !scope }
  );
  const listed = trpc.todos.list.useQuery(
    { view, today: todayKey },
    { enabled: !scope }
  );
  const forIssue = trpc.todos.forIssue.useQuery(
    scope ?? { issueKey: "", connectionId: 0 },
    { enabled: !!scope }
  );
  const items = useMemo(
    () => (scope ? forIssue.data : listed.data) ?? [],
    [scope, forIssue.data, listed.data]
  );
  const list = useRef<HTMLUListElement>(null);
  // A TODO hung on a pinboard shows as it is: its post-its follow.
  const refresh = () =>
    Promise.all([utils.todos.invalidate(), utils.pinboard.list.invalidate()]);
  const working = useTodoWorking().data ?? null;
  const planned = usePlannedToday(todayKey);
  const work = useTodoWork();

  const update = (id: number, patch: Patch) =>
    // Today goes along: a repeating TODO ticked comes back from it.
    utils.client.todos.update
      .mutate({ id, today: todayKey, ...patch })
      .then(refresh, e => {
        toastError(e);
        throw e;
      });

  const tick = (x: Todo, done: boolean) =>
    // Done while its issue's timer runs for it: that timer stops too, its time to log.
    (done && working?.todoId === x.id && working.linked
      ? work.stop(working)
      : Promise.resolve()
    )
      .then(() => update(x.id, { done }))
      .then(() =>
        toast.success(
          t(done ? "views.todos.ticked" : "views.todos.unticked", {
            text: x.text,
          }),
          {
            action: {
              label: t("views.todos.undo"),
              onClick: () => void update(x.id, { done: !done }),
            },
          }
        )
      );
  const remove = (x: Todo) =>
    void utils.client.todos.remove.mutate({ id: x.id }).then(gone => {
      void refresh();
      toast.success(t("views.todos.deleted", { text: x.text }), {
        action: {
          label: t("views.todos.undo"),
          onClick: () =>
            void utils.client.todos.restore
              .mutate({
                text: gone.text,
                dueOn: gone.dueOn,
                done: gone.doneAt !== null,
                position: gone.position,
                issueKey: gone.issueKey,
                connectionId: gone.connectionId,
                commentId: gone.commentId,
                commentExcerpt: gone.commentExcerpt,
                issueNoteId: gone.issueNoteId,
                mailId: gone.mailId,
                priority: gone.priority,
                estimateSeconds: gone.estimateSeconds,
                steps: gone.steps,
                repeat: gone.repeat,
                source: gone.source,
              })
              .then(refresh, toastError),
        },
      });
    }, toastError);
  /**
   * Alt+↑/↓: one place up or down in the list shown, within its day (the
   * lists go by day first; "Done" by when, so nothing to move there).
   */
  const shift = (x: Todo, by: -1 | 1) => {
    if (view === "done" && !scope) return;
    const ids = items.map(i => i.id);
    const at = ids.indexOf(x.id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= ids.length || items[to].dueOn !== x.dueOn)
      return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    void utils.client.todos.reorder
      .mutate({ ids })
      .then(() => refresh().then(() => focusRow(to)), toastError);
  };
  /** After a change that may take a row away: the focus on the row now at that place (or the last one). */
  const focusRow = (at: number) =>
    requestAnimationFrame(() => {
      const rows = [
        ...(list.current?.querySelectorAll<HTMLElement>("[data-todo-row]") ??
          []),
      ];
      (
        rows[Math.min(at, rows.length - 1)] ??
        list.current
          ?.closest("section")
          ?.querySelector<HTMLElement>("[data-float-search]")
      )?.focus();
    });
  const keep = (at: number, p: Promise<unknown>) =>
    void p.then(() => refresh().then(() => focusRow(at)));

  const rowKeys = (e: KeyboardEvent<HTMLLIElement>, x: Todo) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey) return;
    const rows = [
      ...(list.current?.querySelectorAll<HTMLElement>("[data-todo-row]") ?? []),
    ];
    const at = rows.indexOf(e.currentTarget);
    const focus = (i: number) =>
      rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
    const done = () => e.preventDefault();
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown"))
      return (done(), shift(x, e.key === "ArrowUp" ? -1 : 1));
    if (e.altKey) return;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        return (done(), focus(at + 1));
      case "k":
      case "ArrowUp":
        return (done(), focus(at - 1));
      // The row may leave the view: the focus stays in the list, on the row that takes its place.
      case "x":
      case " ":
        return (done(), keep(at, tick(x, x.doneAt === null)));
      case "Delete":
      case "Backspace":
        return (
          done(),
          remove(x),
          focus(at + 1 < rows.length ? at + 1 : at - 1)
        );
      case "1":
        return (done(), keep(at, update(x.id, { dueOn: todayKey })));
      case "2":
        return (
          done(),
          keep(at, update(x.id, { dueOn: dayKey(addDays(today, 1)) }))
        );
      case "0":
        return (done(), keep(at, update(x.id, { dueOn: null })));
    }
  };

  const empty = scope
    ? t("views.todos.emptyIssue")
    : t(`views.todos.empty.${view}`);
  // The upcoming ones under the day they are planned for.
  const dayOf = (x: Todo, i: number) =>
    view === "upcoming" && x.dueOn && x.dueOn !== items[i - 1]?.dueOn
      ? x.dueOn
      : null;

  return (
    <section
      className={cn("flex min-h-0 flex-col gap-2", className)}
      aria-label={t("views.todos.title")}
    >
      <Capture
        scope={scope}
        view={view}
        today={today}
        lang={lang}
        onAdded={refresh}
        onLanded={v => !scope && v !== view && setView(v)}
      />
      {!scope && (
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<View>
            label={t("views.todos.views")}
            value={view}
            onChange={setView}
            className="self-start"
            options={(["today", "upcoming", "someday", "done"] as const).map(
              v => {
                const n = v === "done" ? null : (counts.data?.[v] ?? null);
                return {
                  value: v,
                  label: n
                    ? `${t(`views.todos.tabs.${v}`)} ${n}`
                    : t(`views.todos.tabs.${v}`),
                };
              }
            )}
          />
          {view === "today" && planned && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={replanToday}
            >
              <CalendarCheck className="h-4 w-4" aria-hidden />
              {t("views.todos.planAgain")}
            </Button>
          )}
        </div>
      )}
      {!scope && view === "today" && !planned && (
        <PlanToday
          today={today}
          late={items.filter(x => x.dueOn !== null && x.dueOn < todayKey)}
          onChanged={() => void refresh()}
        />
      )}
      <ul
        ref={list}
        aria-label={
          scope ? t("views.todos.issueList") : t(`views.todos.tabs.${view}`)
        }
        className="cast-room-x cast-room-y grid min-h-0 flex-1 content-start gap-0.5 overflow-y-auto [--room-b:0.125rem] [--room-t:0.125rem] [--room-x:0.25rem]"
      >
        {(
          scope ? forIssue.isPending : listed.isPending
        ) ? null : items.length === 0 ? (
          <li className="px-2 py-6 text-center text-body-sm text-muted-foreground">
            {empty}
          </li>
        ) : (
          items.map((x, i) => {
            const heading = dayOf(x, i);
            return (
              <TodoRow
                key={x.id}
                x={x}
                heading={heading ? dayLabel(heading, today) : null}
                today={today}
                showIssue={!scope}
                onTick={done => void tick(x, done).catch(() => undefined)}
                onUpdate={patch => update(x.id, patch).catch(() => undefined)}
                onRemove={() => remove(x)}
                onKeyDown={e => rowKeys(e, x)}
                working={working?.todoId === x.id}
                onWork={() =>
                  working?.todoId === x.id ? work.stop(working) : work.start(x)
                }
              />
            );
          })
        )}
      </ul>
    </section>
  );
}

/**
 * The capture field, with its parts as chips under it: the day (the tab's
 * unless changed), the issue, the priority, the estimate, the repeat. Typing
 * "@tomorrow" or "#APP-12" sets the same chips, for whoever likes to type.
 */
function Capture({
  scope,
  view,
  today,
  lang,
  onAdded,
  onLanded,
}: {
  scope?: Scope;
  view: View;
  today: Date;
  lang: "it" | "en";
  onAdded: () => void;
  onLanded: (v: View) => void;
}) {
  const utils = trpc.useUtils();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // undefined: not chosen (the tab's day, the typed one); null: chosen none.
  const [day, setDay] = useState<string | null | undefined>(undefined);
  const [issue, setIssue] = useState<IssueRef | null | undefined>(undefined);
  const [high, setHigh] = useState(false);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [repeat, setRepeat] = useState<TodoRepeat | null>(null);
  const parsed = parseTodoInput(text, today, lang);
  const todayKey = dayKey(today);
  // Without a day typed or chosen: the day of the tab it is written in.
  const fallbackDay = scope
    ? null
    : view === "today"
      ? todayKey
      : view === "upcoming"
        ? dayKey(addDays(today, 1))
        : null;
  const dueOn = parsed.dueOn ?? (day === undefined ? fallbackDay : day);
  const scoped = scope
    ? { key: scope.issueKey, connectionId: scope.connectionId }
    : null;
  const linked: IssueRef | null = parsed.issueKey
    ? { key: parsed.issueKey }
    : issue === undefined
      ? scoped
      : issue;
  const drop = (token: string | null) =>
    token &&
    setText(v =>
      v
        .split(/\s+/)
        .filter(w => w !== token)
        .join(" ")
    );
  const reset = () => {
    setText("");
    setDay(undefined);
    setIssue(undefined);
    setHigh(false);
    setEstimate(null);
    setRepeat(null);
  };
  const add = () => {
    if (!parsed.text || busy) return;
    setBusy(true);
    void utils.client.todos.add
      .mutate({
        text: parsed.text,
        dueOn,
        ...(linked
          ? { issueKey: linked.key, connectionId: linked.connectionId }
          : {}),
        priority: high ? 1 : 0,
        estimateSeconds: estimate,
        repeat,
      })
      .then(row => {
        reset();
        onAdded();
        const landed: View = !row.dueOn
          ? "someday"
          : row.dueOn <= todayKey
            ? "today"
            : "upcoming";
        onLanded(landed);
      }, toastError)
      .finally(() => setBusy(false));
  };
  return (
    <div className="grid gap-1.5">
      <Input
        data-float-search
        data-float-autofocus
        aria-label={t("views.todos.captureLabel")}
        placeholder={t("views.todos.capturePlaceholder")}
        value={text}
        // Busy, it stays focused (not disabled): the next TODO is typed at once.
        aria-busy={busy || undefined}
        readOnly={busy}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Escape" && text) {
            // First Esc empties the field; the next one closes the panel.
            e.preventDefault();
            reset();
          }
        }}
      />
      <div
        role="group"
        aria-label={t("views.todos.captureDetails")}
        className="flex flex-wrap items-center gap-1 text-caption"
      >
        <DayChip
          dueOn={dueOn}
          today={today}
          onPlan={d => {
            drop(parsed.dayToken);
            setDay(d);
          }}
        />
        {!scope && (
          <IssueChip
            value={linked}
            onChange={i => {
              drop(parsed.issueToken);
              setIssue(i);
            }}
          />
        )}
        <PriorityChip high={high} onChange={setHigh} />
        <EstimateChip seconds={estimate} onChange={setEstimate} />
        <RepeatChip repeat={repeat} onChange={setRepeat} />
        {text && (
          <span className="text-muted-foreground">
            {t("views.todos.captureHint")}
          </span>
        )}
      </div>
    </div>
  );
}

type Patch = {
  text?: string;
  dueOn?: string | null;
  done?: boolean;
  issueKey?: string | null;
  connectionId?: number;
  priority?: 0 | 1;
  estimateSeconds?: number | null;
  repeat?: TodoRepeat | null;
  steps?: TodoStep[];
  mailId?: number | null;
};

function TodoRow({
  x,
  heading,
  today,
  showIssue,
  onTick,
  onUpdate,
  onRemove,
  onKeyDown,
  working,
  onWork,
}: {
  x: Todo;
  heading: string | null;
  today: Date;
  showIssue: boolean;
  onTick: (done: boolean) => void;
  onUpdate: (patch: Patch) => Promise<unknown>;
  onRemove: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLLIElement>) => void;
  /** Worked on now (its time runs). */
  working: boolean;
  onWork: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "link">("view");
  const [stepsOpen, setStepsOpen] = useState(false);
  const [mailOpen, setMailOpen] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const linking = useRef(false);
  const [draft, setDraft] = useState(x.text);
  const pin = usePinIssue();
  const pinTodo = usePinTodo();
  const todayKey = dayKey(today);
  const done = x.doneAt !== null;
  const late = !done && !!x.dueOn && x.dueOn < todayKey;
  const at = x.issueKey
    ? issuePath({ key: x.issueKey, connectionId: x.connectionId })
    : null;
  const steps = parseSteps(x.steps);
  const repeat = TODO_REPEATS.find(r => r === x.repeat) ?? null;
  // Leaving a field by the keyboard: the focus back on the row (a click elsewhere keeps its own).
  const back = (refocus = false) => {
    setMode("view");
    if (refocus) requestAnimationFrame(() => row.current?.focus());
  };

  return (
    <>
      {heading && (
        <li
          className="px-2 pt-2 text-caption font-medium text-muted-foreground"
          aria-hidden
        >
          {heading}
        </li>
      )}
      <li
        ref={row}
        data-todo-row
        tabIndex={0}
        aria-label={x.text}
        className="group min-w-0 rounded-md px-2 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={e => {
          if (mode !== "view") return;
          if (
            e.target === e.currentTarget &&
            (e.key === "e" || e.key === "Enter")
          ) {
            e.preventDefault();
            setDraft(x.text);
            setMode("edit");
            return;
          }
          onKeyDown(e);
        }}
      >
        <ActionRow
          className="items-start"
          leading={
            <Checkbox
              className="mt-0.5"
              checked={done}
              aria-label={t(done ? "views.todos.untick" : "views.todos.tick", {
                text: x.text,
              })}
              onCheckedChange={v => onTick(v === true)}
            />
          }
          actions={
            <>
              {!done && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={working}
                  aria-label={t(
                    working
                      ? "views.todos.workStop"
                      : x.issueKey
                        ? "views.todos.workStartIssue"
                        : "views.todos.workStart",
                    { text: x.text }
                  )}
                  title={t(
                    working
                      ? "views.todos.workStop"
                      : x.issueKey
                        ? "views.todos.workStartIssue"
                        : "views.todos.workStart",
                    { text: x.text }
                  )}
                  onClick={onWork}
                  className={cn(
                    "shrink-0",
                    working
                      ? "text-primary-strong"
                      : "text-muted-foreground opacity-60 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
                  )}
                >
                  {working ? (
                    <Square className="h-4 w-4" aria-hidden />
                  ) : (
                    <Play className="h-4 w-4" aria-hidden />
                  )}
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("views.todos.actions", { text: x.text })}
                    className="shrink-0 text-muted-foreground opacity-60 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={e => {
                    if (linking.current) e.preventDefault();
                    linking.current = false;
                  }}
                >
                  <DropdownMenuItem
                    onSelect={() => {
                      linking.current = true;
                      setMode("link");
                    }}
                  >
                    <Link2 className="h-4 w-4" aria-hidden />
                    {x.issueKey
                      ? t("views.todos.relink")
                      : t("views.todos.link")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void onUpdate({ priority: x.priority === 1 ? 0 : 1 })
                    }
                  >
                    <Flag className="h-4 w-4" aria-hidden />
                    {x.priority === 1
                      ? t("views.todos.priorityOff")
                      : t("views.todos.priorityOn")}
                  </DropdownMenuItem>
                  {x.estimateSeconds === null && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Hourglass className="h-4 w-4" aria-hidden />
                        {t("views.todos.estimate")}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {[15, 30, 60, 120, 240].map(m => (
                          <DropdownMenuItem
                            key={m}
                            onSelect={() =>
                              void onUpdate({ estimateSeconds: m * 60 })
                            }
                          >
                            {formatDuration(m * 60)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  {!repeat && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Repeat className="h-4 w-4" aria-hidden />
                        {t("views.todos.repeat")}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {TODO_REPEATS.map(r => (
                          <DropdownMenuItem
                            key={r}
                            onSelect={() => void onUpdate({ repeat: r })}
                          >
                            {t(`views.todos.repeats.${r}`)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  <DropdownMenuItem onSelect={() => void pinTodo(x)}>
                    <Pin className="h-4 w-4 -rotate-12" aria-hidden />
                    {t("views.todos.pinTodo")}
                  </DropdownMenuItem>
                  {x.mail ? (
                    <DropdownMenuItem
                      onSelect={() => void onUpdate({ mailId: null })}
                    >
                      <X className="h-4 w-4" aria-hidden />
                      {t("ui.mail.forget")}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => setMailOpen(true)}>
                      <MailPlus className="h-4 w-4" aria-hidden />
                      {t("ui.mail.aboutAction")}
                    </DropdownMenuItem>
                  )}
                  {steps.length === 0 && (
                    <DropdownMenuItem onSelect={() => setStepsOpen(true)}>
                      <ListChecks className="h-4 w-4" aria-hidden />
                      {t("views.todos.stepAdd")}
                    </DropdownMenuItem>
                  )}
                  {x.issueKey && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => void onUpdate({ issueKey: null })}
                      >
                        <X className="h-4 w-4" aria-hidden />
                        {t("views.todos.unlink")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          pin(x.issueKey as string, x.connectionId ?? undefined)
                        }
                      >
                        <Pin className="h-4 w-4 -rotate-12" aria-hidden />
                        {t("views.todos.pinIssue")}
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onRemove} className="text-danger">
                    <Trash2 className="h-4 w-4" aria-hidden />
                    {t("views.todos.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        >
          {mode === "edit" ? (
            <Input
              autoFocus
              aria-label={t("views.todos.editLabel")}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={() => back()}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === "Escape") return (e.preventDefault(), back(true));
                if (e.key !== "Enter") return;
                e.preventDefault();
                const v = draft.trim();
                if (v && v !== x.text) void onUpdate({ text: v });
                back(true);
              }}
            />
          ) : (
            <p
              className={cn(
                "[overflow-wrap:anywhere] text-body-sm",
                done && "text-muted-foreground line-through",
                x.priority === 1 && !done && "font-medium"
              )}
              onDoubleClick={() => {
                setDraft(x.text);
                setMode("edit");
              }}
            >
              {x.priority === 1 && (
                <Flag
                  className="mr-1 inline h-3 w-3 -translate-y-px text-primary-strong"
                  aria-label={t("views.todos.priority")}
                />
              )}
              {x.text}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1 text-caption">
            <DayChip
              dueOn={x.dueOn}
              today={today}
              late={late}
              onPlan={dueOn => void onUpdate({ dueOn })}
            />
            {mode === "link" ? (
              <IssueChip
                defaultOpen
                onClose={() => back(true)}
                value={
                  x.issueKey
                    ? {
                        key: x.issueKey,
                        connectionId: x.connectionId ?? undefined,
                      }
                    : null
                }
                onChange={i =>
                  void onUpdate(
                    i
                      ? { issueKey: i.key, connectionId: i.connectionId }
                      : { issueKey: null }
                  )
                }
              />
            ) : (
              showIssue &&
              x.issueKey &&
              at && (
                <Link
                  to={at}
                  title={x.summary ?? undefined}
                  className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Link2 className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">
                    {x.summary ? `${x.issueKey} · ${x.summary}` : x.issueKey}
                  </span>
                </Link>
              )
            )}
            {x.commentId && at && (
              <Link
                to={`${at}#comment-${encodeURIComponent(x.commentId)}`}
                title={x.commentExcerpt ?? undefined}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MessageSquare className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{t("views.todos.fromComment")}</span>
              </Link>
            )}
            {x.issueNoteId && at && (
              <Link
                to={`${at}#note-${x.issueNoteId}`}
                title={x.noteBody ?? undefined}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <NotebookPen className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{t("views.todos.fromNote")}</span>
              </Link>
            )}
            {x.mail && (
              <span
                title={t("ui.mail.about", { subject: x.mail.subject })}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground"
              >
                <Mail className="h-3 w-3 shrink-0" aria-hidden />
                {x.mail.webLink ? (
                  <ExternalLink url={x.mail.webLink} className="truncate">
                    {x.mail.subject || t("ui.mail.noSubject")}
                  </ExternalLink>
                ) : (
                  <span className="truncate">
                    {x.mail.subject || t("ui.mail.noSubject")}
                  </span>
                )}
              </span>
            )}
            {x.estimateSeconds !== null ? (
              <EstimateChip
                seconds={x.estimateSeconds}
                spent={x.spentSeconds}
                onChange={estimateSeconds => void onUpdate({ estimateSeconds })}
              />
            ) : (
              <>
                {x.spentSeconds >= 60 && <SpentChip seconds={x.spentSeconds} />}
                {/* An open TODO of an issue: the issue's likely time, to take in one click. */}
                {x.doneAt === null && x.issueKey && x.connectionId !== null && (
                  <LikelyChip issueKey={x.issueKey} connectionId={x.connectionId} onPick={estimateSeconds => void onUpdate({ estimateSeconds })} />
                )}
              </>
            )}
            {repeat && (
              <RepeatChip
                repeat={repeat}
                onChange={r => void onUpdate({ repeat: r })}
              />
            )}
            {(steps.length > 0 || stepsOpen) && (
              <StepsChip
                steps={steps}
                open={stepsOpen}
                onToggle={() => setStepsOpen(o => !o)}
              />
            )}
          </div>
          {stepsOpen && (
            <StepsEditor
              steps={steps}
              onChange={next => void onUpdate({ steps: next })}
            />
          )}
        </ActionRow>
      </li>
      <PinMailDialog
        open={mailOpen}
        onOpenChange={setMailOpen}
        onPick={async mail => void (await onUpdate({ mailId: mail.id }))}
      />
    </>
  );
}
