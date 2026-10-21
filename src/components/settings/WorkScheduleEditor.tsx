import { useId, useState } from "react";
import { Copy, Plus, Trash2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useToday } from "@/hooks/useToday";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import {
  addDays,
  dayKey,
  formatDate,
  formatDuration,
  parseDayKey,
  startOfWeek,
} from "@contracts/time";
import {
  expectedSeconds,
  minutesOf,
  scheduleFor,
  workDaySchema,
  EPOCH_DAY,
  type WorkDay,
  type WorkSchedule,
} from "@contracts/workSchedule";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SettingsDisclosure } from "@/components/settings/SettingsGroup";
import { weekSeconds } from "@/lib/weekSeconds";
import { toast } from "sonner";
import { t } from "@/i18n";

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;


/** A break that fits after the last one (lunch by default). */
function nextBreak(day: WorkDay): { start: string; end: string } | null {
  const end = minutesOf(day.end);
  const after = day.breaks.length
    ? minutesOf(day.breaks[day.breaks.length - 1].end)
    : minutesOf(day.start);
  const lunch = minutesOf("13:00");
  const start =
    day.breaks.length === 0 && lunch > after && lunch + 60 <= end
      ? lunch
      : after + 60;
  if (start + 15 > end) return null;
  return { start: hhmm(start), end: hhmm(Math.min(start + 60, end)) };
}

const versionLabel = (validFrom: string) => {
  if (validFrom === EPOCH_DAY) return t("settings.schedule.fromStart");
  const d = parseDayKey(validFrom);
  return d ? t("settings.schedule.fromDate", { date: formatDate(d, "short") }) : validFrom;
};

/** Short weekday names, Monday first. */
const weekdayLabels = () => [
  t("settings.schedule.day.mon"),
  t("settings.schedule.day.tue"),
  t("settings.schedule.day.wed"),
  t("settings.schedule.day.thu"),
  t("settings.schedule.day.fri"),
  t("settings.schedule.day.sat"),
  t("settings.schedule.day.sun"),
];

function TimeInput({
  value,
  onChange,
  label,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <Input
      type="time"
      step={300}
      value={value}
      disabled={disabled}
      aria-label={label}
      aria-invalid={invalid || undefined}
      onChange={e => e.target.value && onChange(e.target.value)}
      className="h-8 w-[6.5rem] px-2 tabular"
    />
  );
}

/**
 * Work hours per weekday with breaks (time when no worklog is expected).
 * Saved as a new version from a chosen date: the days before it keep the
 * hours they were judged with.
 */
export function WorkScheduleEditor() {
  const id = useId();
  const days = weekdayLabels();
  const utils = trpc.useUtils();
  const today = useToday();
  const { versions, isPending } = useWorkSchedule();
  const current = scheduleFor(today, versions);
  const monday = startOfWeek(today);

  const [draft, setDraft] = useState<WorkSchedule | null>(null);
  const [validFrom, setValidFrom] = useState(() => dayKey(today));
  // A past (or future) version opened from the history: read-only.
  const [viewing, setViewing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const viewed = versions.find(v => v.validFrom === viewing);
  const shown = viewed?.schedule ?? draft ?? current;
  const dirty =
    draft !== null && JSON.stringify(draft) !== JSON.stringify(current);
  const errors = shown.map(d => {
    const r = workDaySchema.safeParse(d);
    return r.success
      ? null
      : (r.error.issues[0]?.message ?? t("settings.schedule.invalid"));
  });
  const valid = errors.every(e => e === null);

  const onSaved = (data: typeof versions) => {
    utils.workSchedule.list.setData(undefined, data);
    void utils.workSchedule.list.invalidate();
  };
  const save = trpc.workSchedule.save.useMutation({
    onSuccess: data => {
      onSaved(data);
      setDraft(null);
      toast.success(t("settings.schedule.saved", { version: versionLabel(validFrom).toLowerCase() }));
    },
    onError: e => toast.error(t("settings.schedule.saveFailed", { message: e.message })),
  });
  const remove = trpc.workSchedule.remove.useMutation({
    onSuccess: data => {
      onSaved(data);
      toast.success(t("settings.schedule.versionDeleted"));
    },
    onError: e => toast.error(e.message),
  });

  const edit = (i: number, patch: Partial<WorkDay>) =>
    setDraft(shown.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const editBreak = (
    i: number,
    b: number,
    patch: { start?: string; end?: string }
  ) =>
    edit(i, {
      breaks: shown[i].breaks.map((x, k) => (k === b ? { ...x, ...patch } : x)),
    });
  const copyMonday = () =>
    setDraft(
      shown.map((d, i) =>
        i > 0 && i < 5
          ? { ...shown[0], breaks: shown[0].breaks.map(b => ({ ...b })) }
          : d
      )
    );

  if (isPending) return null;

  return (
    <div className="grid gap-4">
      {viewed && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-primary-soft px-3 py-2 text-body-sm text-primary-strong"
        >
          <span>
            {t("settings.schedule.readOnly", { version: versionLabel(viewed.validFrom).toLowerCase() })}
          </span>
          <span className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(viewed.schedule);
                setViewing(null);
              }}
            >
              {t("settings.schedule.useAsBase")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setViewing(null)}
            >
              {t("settings.schedule.backToCurrent")}
            </Button>
          </span>
        </div>
      )}
      {/* A disabled fieldset turns every control below read-only at once. */}
      <fieldset disabled={!!viewed} className="grid min-w-0 gap-4">
        <ul className="grid gap-1">
          {shown.map((d, i) => {
            const seconds = expectedSeconds(addDays(monday, i), shown);
            const add = nextBreak(d);
            return (
              <li
                key={days[i]}
                className={cn(
                  "grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 rounded-lg px-2 py-2",
                  !d.enabled && "text-muted-foreground"
                )}
              >
                <label className="flex h-8 items-center gap-2 text-body-sm font-medium">
                  <Switch
                    checked={d.enabled}
                    onCheckedChange={enabled => edit(i, { enabled })}
                    aria-label={t("settings.schedule.workday", { day: days[i] })}
                  />
                  {days[i]}
                </label>
                {d.enabled ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="flex items-center gap-1.5">
                      <TimeInput
                        value={d.start}
                        label={t("settings.schedule.start", { day: days[i] })}
                        onChange={start => edit(i, { start })}
                        invalid={errors[i] !== null}
                      />
                      <span aria-hidden>–</span>
                      <TimeInput
                        value={d.end}
                        label={t("settings.schedule.end", { day: days[i] })}
                        onChange={end => edit(i, { end })}
                        invalid={errors[i] !== null}
                      />
                    </span>
                    {d.breaks.map((b, k) => (
                      <span
                        key={k}
                        className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5"
                      >
                        <span className="text-caption text-muted-foreground">
                          {t("settings.schedule.break")}
                        </span>
                        <TimeInput
                          value={b.start}
                          label={t("settings.schedule.breakStart", { day: days[i], n: k + 1 })}
                          onChange={start => editBreak(i, k, { start })}
                        />
                        <span aria-hidden>–</span>
                        <TimeInput
                          value={b.end}
                          label={t("settings.schedule.breakEnd", { day: days[i], n: k + 1 })}
                          onChange={end => editBreak(i, k, { end })}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("settings.schedule.removeBreak", { n: k + 1, day: days[i] })}
                          onClick={() =>
                            edit(i, {
                              breaks: d.breaks.filter((_, x) => x !== k),
                            })
                          }
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    ))}
                    {add && d.breaks.length < 4 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => edit(i, { breaks: [...d.breaks, add] })}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t("settings.schedule.break")}
                      </Button>
                    )}
                    {errors[i] && (
                      <p
                        role="alert"
                        className="basis-full text-caption text-danger"
                      >
                        {errors[i]}
                      </p>
                    )}
                  </div>
                ) : (
                  <span className="flex h-8 items-center text-body-sm">
                    {t("settings.schedule.dayOff")}
                  </span>
                )}
                <span className="flex h-8 items-center justify-end text-body-sm tabular text-muted-foreground">
                  {d.enabled ? formatDuration(seconds) : "—"}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-body-sm">
          <Button type="button" variant="ghost" size="sm" onClick={copyMonday}>
            <Copy className="h-3.5 w-3.5" />
            {t("settings.schedule.copyMonday")}
          </Button>
          <span>
            {t("settings.schedule.weekTotal")}{" "}
            <span className="font-semibold tabular">
              {formatDuration(weekSeconds(shown, monday))}
            </span>
          </span>
        </div>
      </fieldset>

      {!viewed && (
        <div className="grid gap-3 rounded-lg bg-muted/60 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-from`}>{t("settings.schedule.validFrom")}</Label>
              <Input
                id={`${id}-from`}
                type="date"
                value={validFrom}
                onChange={e => e.target.value && setValidFrom(e.target.value)}
                className="h-9 w-40"
              />
            </div>
            <Button
              type="button"
              disabled={!dirty || !valid || save.isPending}
              onClick={() => save.mutate({ validFrom, schedule: shown })}
            >
              {t("settings.schedule.save")}
            </Button>
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDraft(null)}
              >
                {t("settings.schedule.discard")}
              </Button>
            )}
          </div>
          <p className="text-caption text-muted-foreground">
            {t("settings.schedule.validFromHint")}
          </p>
        </div>
      )}

      {versions.length > 0 && (
        <SettingsDisclosure
          id="schedule-history"
          title={t("settings.schedule.history", { count: versions.length })}
          keywords={t("settings.schedule.historyKeywords")}
        >
          <ul className="divide-y text-body-sm">
            {[...versions].reverse().map(v => (
              <li
                key={v.validFrom}
                className="flex items-center justify-between gap-2 py-1.5"
              >
                <button
                  type="button"
                  aria-pressed={viewing === v.validFrom}
                  onClick={() =>
                    setViewing(viewing === v.validFrom ? null : v.validFrom)
                  }
                  className={cn(
                    "rounded-sm text-left underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40",
                    viewing === v.validFrom && "font-semibold"
                  )}
                >
                  {versionLabel(v.validFrom)}
                  <span className="text-muted-foreground">
                    {" · "}
                    {t("settings.categories.schedule.summary", { duration: formatDuration(weekSeconds(v.schedule, monday)) })}
                  </span>
                </button>
                <span className="flex items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft(v.schedule);
                      setViewing(null);
                    }}
                  >
                    {t("settings.schedule.useAsBase")}
                  </Button>
                  {v.validFrom !== EPOCH_DAY && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("settings.schedule.deleteVersion", { version: versionLabel(v.validFrom).toLowerCase() })}
                      disabled={remove.isPending}
                      onClick={() => setRemoving(v.validFrom)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </SettingsDisclosure>
      )}

      <AlertDialog open={removing !== null} onOpenChange={o => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.schedule.deleteTitle", { version: removing ? versionLabel(removing).toLowerCase() : "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.schedule.deleteBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                if (removing) remove.mutate({ validFrom: removing });
              }}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
