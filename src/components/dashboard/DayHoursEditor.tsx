import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Clock, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Chip } from "@/components/app/Chip";
import { TimeInput } from "@/components/app/TimeInput";
import { useDirtyClose } from "@/components/app/DirtyClose";
import { surface } from "@/components/app/surface";
import { dayMonth } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { formatDurationLong } from "@contracts/time";
import { minutesOf, sameWorkDay, workDaySeconds, type WorkDay } from "@contracts/workSchedule";
import { workDaySchema } from "@contracts/workScheduleSchema";
import { t } from "@/i18n";
import { isTyping } from "@/lib/dom";
import { addBreak, BIG_STEP, handleAt, moveHandle, removeBreak, saveChoice, snapTo, STEP, type Handle } from "./dayHours";
import type { DayHoursEdit, EditAxis } from "./useDayHoursEdit";

/** A press moves nothing until the pointer has gone this far: a click never edits. */
const DRAG_THRESHOLD_PX = 4;
/** A break this wide (px) shows "13:00–14:00"; narrower, "13:00"; narrower still, nothing. */
const BOTH_TIMES_PX = 80;
const ONE_TIME_PX = 40;
/** A time field in the sheet: its column's width, a finger's height on touch screens. */
const FIELD = "h-touch w-full min-w-0 sm:h-8 sm:coarse:h-touch";

const stepOf = (e: { shiftKey: boolean; altKey: boolean }) => (e.altKey ? 1 : e.shiftKey ? BIG_STEP : STEP);
const sameHandle = (a: Handle | null, b: Handle) => !!a && a.kind === b.kind && ("i" in a ? a.i : -1) === ("i" in b ? b.i : -1);

/**
 * The handles over the timeline while its day's hours are edited: the day's
 * start and end, each break's edges and the break itself. Pointer (after a
 * few pixels, so a click never moves anything) or keyboard (arrows by 5 min,
 * Shift by 15, Alt by 1); Escape during a drag puts it back.
 */
export function DayHoursHandles({
  draft,
  onChange,
  axis,
  onSubmit,
}: {
  draft: WorkDay;
  onChange: (d: WorkDay) => void;
  axis: EditAxis;
  /** Enter on a handle: save. */
  onSubmit: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const span = (axis.last - axis.first) * 60;
  // Never off the drawn axis: what can't be seen can't be dragged to.
  const onAxis = (min: number) => Math.min(axis.last * 60, Math.max(axis.first * 60, min));
  const pct = (min: number) => ((min - axis.first * 60) / span) * 100;
  // The layer's width: a break's times are written only where they fit (never cut to "14:…").
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [draft.enabled]);
  const drag = useRef<{ handle: Handle; x: number; from: WorkDay; at: number; moved: boolean; pointer: number } | null>(null);
  const [active, setActive] = useState<Handle | null>(null);

  const down = (handle: Handle) => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { handle, x: e.clientX, from: draft, at: handleAt(draft, handle), moved: false, pointer: e.pointerId };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    setActive(d.handle);
    const width = layer.current?.getBoundingClientRect().width || 1;
    onChange(moveHandle(d.from, d.handle, onAxis(snapTo(d.at + (dx / width) * span, stepOf(e)))));
  };
  const up = (e: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointer !== e.pointerId) return;
    drag.current = null;
    setActive(null);
  };
  const cancelDrag = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    onChange(d.from);
    drag.current = null;
    setActive(null);
  };
  const key = (handle: Handle) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && drag.current) {
      e.stopPropagation();
      onChange(drag.current.from);
      drag.current = null;
      setActive(null);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
      return;
    }
    const dir = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const step = stepOf(e);
    onChange(moveHandle(draft, handle, onAxis(snapTo(handleAt(draft, handle) + dir * step, step))));
  };

  const slider = (handle: Handle, label: string, value: number) => ({
    role: "slider" as const,
    tabIndex: 0,
    "data-handle": handle.kind,
    "aria-label": label,
    "aria-valuemin": 0,
    "aria-valuemax": 24 * 60 - 5,
    "aria-valuenow": value,
    "aria-valuetext": label,
    onPointerDown: down(handle),
    onPointerMove: move,
    onPointerUp: up,
    onPointerCancel: cancelDrag,
    onLostPointerCapture: up,
    onKeyDown: key(handle),
  });
  const ring = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

  if (!draft.enabled) return null;
  const start = minutesOf(draft.start);
  const end = minutesOf(draft.end);
  return (
    <div ref={layer} className="absolute inset-x-0 bottom-6 top-3 z-30 touch-none select-none">
      {/* The day's edges: a 24 px grip on each, the line where the hours begin and end. */}
      {([["start", start, t("views.dashboard.timeline.hours.start", { time: draft.start })], ["end", end, t("views.dashboard.timeline.hours.end", { time: draft.end })]] as const).map(([kind, at, label]) => (
        <div
          key={kind}
          {...slider({ kind }, label, at)}
          title={label}
          className={cn("absolute inset-y-0 flex w-6 -translate-x-1/2 cursor-ew-resize justify-center rounded-md coarse:w-touch", ring)}
          style={{ left: `${pct(at)}%` }}
        >
          <span aria-hidden className={cn("h-full w-1 rounded-full bg-primary-strong", sameHandle(active, { kind }) && "w-1.5")} />
          {sameHandle(active, { kind }) && <TimeTag>{kind === "start" ? draft.start : draft.end}</TimeTag>}
        </div>
      ))}
      {draft.breaks.map((b, i) => {
        const from = minutesOf(b.start);
        const to = minutesOf(b.end);
        const moving = sameHandle(active, { kind: "break", i }) || sameHandle(active, { kind: "breakStart", i }) || sameHandle(active, { kind: "breakEnd", i });
        return (
          <div
            key={i}
            {...surface("glass")}
            className="absolute inset-y-0 rounded-md border-2 border-primary-strong bg-primary-soft"
            style={{ left: `${pct(from)}%`, width: `${pct(to) - pct(from)}%` }}
          >
            <div
              {...slider({ kind: "break", i }, t("views.dashboard.timeline.hours.breakMove", { from: b.start, to: b.end }), from)}
              title={t("views.dashboard.timeline.hours.breakMove", { from: b.start, to: b.end })}
              className={cn("absolute inset-y-0 left-1/2 flex w-full -translate-x-1/2 cursor-grab items-start justify-center overflow-hidden rounded-md active:cursor-grabbing min-w-target coarse:min-w-touch", ring)}
            >
              {(() => {
                const px = ((to - from) / span) * width;
                const text = px >= BOTH_TIMES_PX ? `${b.start}–${b.end}` : px >= ONE_TIME_PX ? b.start : null;
                return text && <span className="whitespace-nowrap px-1 pt-1.5 text-caption font-medium text-primary-strong tabular">{text}</span>;
              })()}
            </div>
            {/* The break is at least a target wide to move it (a finger's on a touch screen), each edge's grip just outside that: none covers another. */}
            <div
              {...slider({ kind: "breakStart", i }, t("views.dashboard.timeline.hours.breakStart", { time: b.start }), from)}
              className={cn("absolute inset-y-0 right-[max(100%,calc(50%_+_theme(spacing.target)/2))] w-target cursor-ew-resize rounded-md coarse:right-[max(100%,calc(50%_+_theme(spacing.touch)/2))] coarse:w-touch", ring)}
            />
            <div
              {...slider({ kind: "breakEnd", i }, t("views.dashboard.timeline.hours.breakEnd", { time: b.end }), to)}
              className={cn("absolute inset-y-0 left-[max(100%,calc(50%_+_theme(spacing.target)/2))] w-target cursor-ew-resize rounded-md coarse:left-[max(100%,calc(50%_+_theme(spacing.touch)/2))] coarse:w-touch", ring)}
            />
            {moving && <TimeTag>{b.start}–{b.end}</TimeTag>}
          </div>
        );
      })}
    </div>
  );
}

function TimeTag({ children }: { children: React.ReactNode }) {
  return (
    <span
      {...surface("chip")}
      className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border bg-card px-1.5 py-0.5 text-caption font-medium text-foreground tabular"
    >
      {children}
    </span>
  );
}

/** Save `draft`: at once, or by one of the two readings when the day's work changes. */
function SaveActions({ edit, draft, onSave, size = "sm" }: { edit: DayHoursEdit; draft: WorkDay; onSave: (d: WorkDay) => void; size?: "sm" | "default" }) {
  const choice = saveChoice(edit.current, edit.base, draft);
  if (!choice)
    return (
      <Button size={size} disabled={edit.pending || sameWorkDay(draft, edit.current)} onClick={() => onSave(draft)}>
        {t("views.dashboard.timeline.hours.save")}
      </Button>
    );
  const target = formatDurationLong(choice.baseSeconds);
  return (
    <>
      <p className="basis-full text-body-sm text-muted-foreground" role="status">
        {t("views.dashboard.timeline.hours.changesTarget", { before: target, after: formatDurationLong(choice.draftSeconds) })}
      </p>
      <Button
        size={size}
        variant="outline"
        disabled={edit.pending || !choice.keep}
        title={choice.keep ? undefined : t("views.dashboard.timeline.hours.keepTargetNo", { target })}
        onClick={() => choice.keep && onSave(choice.keep)}
      >
        {choice.keep ? t("views.dashboard.timeline.hours.keepTarget", { target, end: choice.keep.end }) : t("views.dashboard.timeline.hours.keepTargetNo", { target })}
      </Button>
      <Button size={size} disabled={edit.pending} onClick={() => onSave(draft)}>
        {t("views.dashboard.timeline.hours.keepHours", { target: formatDurationLong(choice.draftSeconds) })}
      </Button>
    </>
  );
}

/**
 * Above the day's timeline: "Hours of the day" (and whether the day has its
 * own), or, while editing, what can be done to the draft and how to save it.
 * Escape cancels the draft.
 */
export const DayHoursBar = memo(function DayHoursBar({
  edit,
  locked,
  onStart,
  onFields,
  fieldsOnly,
}: {
  edit: DayHoursEdit;
  locked: boolean;
  /** Start editing on the timeline (the page first closes what would get in the way). */
  onStart: () => void;
  onFields: () => void;
  /** A phone: the fields, never the drag. */
  fieldsOnly: boolean;
}) {
  const draft = edit.draft;
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      // A dialog or sheet open over the page takes its own Escape.
      // Escape in a field on the page clears or leaves the field, not the draft.
      if (e.key === "Escape" && !e.defaultPrevented && !isTyping(e.target) && !document.querySelector("[role=dialog], [role=alertdialog]")) edit.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, edit]);

  // Keyboard: into edit mode on the first break (else the day's start), and back on
  // "Hours of the day" when it ends (saved, cancelled, Escape): never lost on the page.
  const editing = !!draft;
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing === wasEditing.current) return;
    wasEditing.current = editing;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (editing) {
      if (!lost && !document.activeElement?.matches("[data-day-hours-edit]")) return;
      const first = document.querySelector<HTMLElement>("[data-handle=break]") ?? document.querySelector<HTMLElement>("[data-handle=start]");
      first?.focus({ preventScroll: true });
    } else if (lost) {
      document.querySelector<HTMLElement>("[data-day-hours-edit]")?.focus({ preventScroll: true });
    }
  }, [editing]);

  if (!draft) {
    const own = edit.overridden;
    return (
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={locked || edit.closed || !edit.ready}
          title={locked || edit.closed ? t("views.dashboard.timeline.hours.locked") : t("views.dashboard.timeline.hours.editHint")}
          onClick={fieldsOnly ? onFields : onStart}
          data-day-hours-edit=""
        >
          <Clock className="h-4 w-4" aria-hidden />
          {t("views.dashboard.timeline.hours.edit")}
        </Button>
        {own && (
          <>
            <span
              title={
                edit.current.enabled
                  ? t("views.dashboard.timeline.hours.ownTitle", { from: edit.current.start, to: edit.current.end })
                  : t("views.dashboard.timeline.hours.ownOff")
              }
            >
              <Chip tone="info" variant="dot">
                {t("views.dashboard.timeline.hours.own")}
              </Chip>
            </span>
            {!locked && (
              <Button variant="link" size="sm" disabled={edit.pending} onClick={() => void edit.reset()}>
                {t("views.dashboard.timeline.hours.reset")}
              </Button>
            )}
          </>
        )}
      </div>
    );
  }

  const more = addBreak(draft);
  return (
    <div {...surface("card")} className="mb-2 grid gap-2 rounded-lg border bg-card p-2">
      <p className="text-caption text-muted-foreground">{t("views.dashboard.timeline.hours.editing")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {draft.enabled &&
          draft.breaks.map((b, i) => (
            <Button
              key={i}
              variant="outline"
              size="sm"
              aria-label={t("views.dashboard.timeline.hours.removeBreak", { from: b.start, to: b.end })}
              title={t("views.dashboard.timeline.hours.removeBreak", { from: b.start, to: b.end })}
              onClick={() => edit.setDraft(removeBreak(draft, i))}
            >
              <span className="tabular">
                {b.start}–{b.end}
              </span>
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ))}
        {draft.enabled && (
          <Button variant="outline" size="sm" disabled={!more} onClick={() => more && edit.setDraft(more)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("views.dashboard.timeline.hours.addBreak")}
          </Button>
        )}
        <Label className="inline-flex min-h-target items-center gap-2 text-body-sm">
          <Switch checked={!draft.enabled} onCheckedChange={off => edit.setDraft({ ...draft, enabled: !off })} />
          {t("views.dashboard.timeline.hours.dayOff")}
        </Label>
        <Button variant="ghost" size="sm" onClick={onFields}>
          {t("views.dashboard.timeline.hours.fields")}
        </Button>
        <span className="ml-auto text-body-sm text-muted-foreground tabular">
          {t("views.dashboard.timeline.hours.work", { duration: formatDurationLong(workDaySeconds(draft)) })}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={edit.pending} onClick={edit.cancel}>
          {t("views.dashboard.timeline.hours.cancel")}
        </Button>
        <SaveActions edit={edit} draft={draft} onSave={d => void edit.commit(d)} />
      </div>
    </div>
  );
});

/**
 * The day's hours as fields: on phones (dragging there moves minutes per
 * pixel) and, everywhere, the way to edit them without dragging. Closing
 * over changes asks first.
 */
export function DayHoursSheet({ day, edit, open, onOpenChange }: { day: Date; edit: DayHoursEdit; open: boolean; onOpenChange: (open: boolean) => void }) {
  const guard = useDirtyClose(() => onOpenChange(false));
  return (
    <>
      {guard.confirm}
      <Sheet open={open} onOpenChange={guard.onOpenChange}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 bg-canvas p-0 sm:max-w-md"
          // Opened by the page, not a trigger: focus goes back to "Hours of the day".
          onCloseAutoFocus={e => {
            const back = document.querySelector<HTMLElement>("[data-day-hours-edit]");
            if (!back) return;
            e.preventDefault();
            back.focus({ preventScroll: true });
          }}
        >
          {open && (
            <DayHoursForm
              day={day}
              edit={edit}
              onDirty={guard.markDirty}
              onDone={() => {
                guard.markDirty(false);
                onOpenChange(false);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function DayHoursForm({ day, edit, onDirty, onDone }: { day: Date; edit: DayHoursEdit; onDirty: (d: boolean) => void; onDone: () => void }) {
  const initial = edit.draft ?? (edit.current.enabled ? edit.current : { ...edit.base, enabled: true });
  const [form, setForm] = useState<WorkDay>(initial);
  const set = (next: WorkDay) => {
    setForm(next);
    onDirty(!sameWorkDay(next, edit.current));
  };
  const parsed = workDaySchema.safeParse(form);
  const error = parsed.success ? null : parsed.error.issues[0]?.message;
  const more = addBreak(form);
  // A refused save keeps the sheet and what was typed.
  const save = async (hours: WorkDay) => {
    if (await edit.commit(hours)) onDone();
  };
  return (
    <>
      <SheetHeader className="border-b p-4">
        <SheetTitle>{t("views.dashboard.timeline.hours.sheetTitle", { day: dayMonth(day) })}</SheetTitle>
        <SheetDescription>{t("views.dashboard.timeline.hours.sheetDescription")}</SheetDescription>
      </SheetHeader>
      <div className="grid flex-1 content-start gap-4 overflow-y-auto p-4">
        <Label className="inline-flex min-h-touch items-center gap-2 text-body">
          <Switch checked={!form.enabled} onCheckedChange={off => set({ ...form, enabled: !off })} />
          {t("views.dashboard.timeline.hours.dayOff")}
        </Label>
        {form.enabled && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Label className="grid min-w-0 gap-1 text-body-sm">
                {t("views.dashboard.timeline.hours.startField")}
                <TimeInput label={t("views.dashboard.timeline.hours.startField")} value={form.start} onChange={v => set({ ...form, start: v })} className={FIELD} />
              </Label>
              <Label className="grid min-w-0 gap-1 text-body-sm">
                {t("views.dashboard.timeline.hours.endField")}
                <TimeInput label={t("views.dashboard.timeline.hours.endField")} value={form.end} onChange={v => set({ ...form, end: v })} className={FIELD} />
              </Label>
            </div>
            <ul className="grid gap-2">
              {form.breaks.map((b, i) => {
                const label = t("views.dashboard.timeline.hours.breakFrom", { n: i + 1 });
                const patch = (p: Partial<typeof b>) => set({ ...form, breaks: form.breaks.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                return (
                  <li key={i} className="grid gap-1 text-body-sm">
                    {/* Its name and × on one line, the two times on the next: whole at 320 px, in a 12 h locale too. */}
                    <div className="flex items-center justify-between gap-2">
                      <span>{label}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="coarse:h-touch coarse:w-touch"
                        aria-label={t("views.dashboard.timeline.hours.removeBreak", { from: b.start, to: b.end })}
                        onClick={() => set(removeBreak(form, i))}
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                      <TimeInput label={label} value={b.start} onChange={v => patch({ start: v })} className={FIELD} />
                      <span>{t("views.dashboard.timeline.hours.breakTo")}</span>
                      <TimeInput label={`${label} ${t("views.dashboard.timeline.hours.breakTo")}`} value={b.end} onChange={v => patch({ end: v })} className={FIELD} />
                    </div>
                  </li>
                );
              })}
            </ul>
            <Button variant="outline" size="sm" className="justify-self-start" disabled={!more} onClick={() => more && set(more)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t("views.dashboard.timeline.hours.addBreak")}
            </Button>
            {error ? (
              <p role="alert" className="text-body-sm text-danger">
                {error}
              </p>
            ) : (
              <p className="text-body-sm text-muted-foreground tabular">
                {t("views.dashboard.timeline.hours.work", { duration: formatDurationLong(workDaySeconds(form)) })}
              </p>
            )}
          </>
        )}
      </div>
      <SheetFooter className="flex-row flex-wrap justify-end gap-2 border-t p-4">
        <Button variant="ghost" onClick={onDone}>
          {t("views.dashboard.timeline.hours.cancel")}
        </Button>
        {parsed.success ? (
          <SaveActions edit={edit} draft={form} onSave={d => void save(d)} size="default" />
        ) : (
          <Button disabled>{t("views.dashboard.timeline.hours.save")}</Button>
        )}
      </SheetFooter>
    </>
  );
}
