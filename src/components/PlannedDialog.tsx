import { useId, useState } from "react";
import { toast } from "sonner";
import { BriefcaseBusiness, CarFront, Palmtree } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";
import { visibleIssues } from "@/lib/issues";
import { addDays, dayKey, toLocalInputValue } from "@contracts/time";
import { plannedDayRange, type PlannedEntry, type PlannedKind } from "@contracts/planned";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { IssuePicker, type IssueRef } from "@/components/app/IssuePicker";
import { t } from "@/i18n";

const kindOptions = () => [
  { value: "work" as const, label: t("ui.planned.work"), icon: BriefcaseBusiness },
  { value: "travel" as const, label: t("ui.planned.travel"), icon: CarFront },
  { value: "vacation" as const, label: t("ui.planned.vacation"), icon: Palmtree },
];

function defaultStart(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
}

function isWholeDays(entry: PlannedEntry): boolean {
  return entry.startsAt.getHours() === 0 && entry.startsAt.getMinutes() === 0 && entry.endsAt.getHours() === 0 && entry.endsAt.getMinutes() === 0;
}

export function PlannedDialog({
  day,
  entry,
  open,
  onOpenChange,
  onLogActual,
}: {
  day: Date;
  entry?: PlannedEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogActual?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && <PlannedForm key={entry?.id ?? "new"} day={day} entry={entry} onClose={() => onOpenChange(false)} onLogActual={onLogActual} />}
      </DialogContent>
    </Dialog>
  );
}

function PlannedForm({ day, entry, onClose, onLogActual }: { day: Date; entry?: PlannedEntry | null; onClose: () => void; onLogActual?: () => void }) {
  const id = useId();
  const utils = trpc.useUtils();
  const issues = trpc.issues.all.useQuery();
  const initialStart = entry?.startsAt ?? defaultStart(day);
  const [kind, setKind] = useState<PlannedKind>(entry?.kind ?? "work");
  const [issue, setIssue] = useState<IssueRef | null>(entry?.issueKey ? { key: entry.issueKey, connectionId: entry.connectionId ?? undefined } : null);
  const [startsAt, setStartsAt] = useState(toLocalInputValue(initialStart));
  const [endsAt, setEndsAt] = useState(() => toLocalInputValue(entry?.endsAt ?? new Date(initialStart.getTime() + 3600_000)));
  const [wholeDays, setWholeDays] = useState(() => entry?.kind === "vacation" ? isWholeDays(entry) : true);
  const [fromDay, setFromDay] = useState(dayKey(initialStart));
  const [throughDay, setThroughDay] = useState(() => dayKey(entry ? addDays(entry.endsAt, -1) : day));
  const [note, setNote] = useState(entry?.note ?? "");

  const saved = () => {
    void utils.planned.invalidate();
    toast.success(t(entry ? "ui.planned.updated" : "ui.planned.created"));
    onClose();
  };
  const create = trpc.planned.create.useMutation({ onSuccess: saved, onError: e => toastError(e) });
  const update = trpc.planned.update.useMutation({ onSuccess: saved, onError: e => toastError(e) });
  const pending = create.isPending || update.isPending;

  const range = kind === "vacation" && wholeDays
    ? plannedDayRange(fromDay, throughDay)
    : (() => {
        const start = new Date(startsAt);
        const end = new Date(endsAt);
        return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start ? null : { startsAt: start, endsAt: end };
      })();
  const invalidInterval = !range;
  const needsIssue = kind === "work" && !issue;
  const canSubmit = !pending && !invalidInterval && !needsIssue;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!range || !canSubmit) return;
    const payload = {
      kind,
      startsAt: range.startsAt.toISOString(),
      endsAt: range.endsAt.toISOString(),
      note: note.trim() || null,
      connectionId: kind === "vacation" ? null : issue?.connectionId ?? null,
      issueKey: kind === "vacation" ? null : issue?.key ?? null,
    };
    if (entry) update.mutate({ id: entry.id, ...payload });
    else create.mutate(payload);
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{t(entry ? "ui.planned.titleEdit" : "ui.planned.titleNew")}</DialogTitle>
        <DialogDescription>{t("ui.planned.description")}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        <SegmentedControl label={t("ui.planned.type")} value={kind} onChange={setKind} options={kindOptions()} />
        {kind !== "vacation" && (
          <div className="grid gap-2">
            <Label htmlFor={`${id}-issue`}>{t(kind === "work" ? "ui.planned.issue" : "ui.planned.issueOptional")}</Label>
            <IssuePicker id={`${id}-issue`} issues={visibleIssues(issues.data ?? [])} value={issue} onChange={setIssue} />
            {needsIssue && <p className="text-body-sm text-muted-foreground">{t("ui.planned.issueHint")}</p>}
          </div>
        )}
        {kind === "vacation" && (
          <label className="flex items-center gap-2 text-body-sm">
            <Checkbox checked={wholeDays} onCheckedChange={checked => setWholeDays(checked === true)} />
            {t("ui.planned.wholeDays")}
          </label>
        )}
        {kind === "vacation" && wholeDays ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={`${id}-from-day`}>{t("ui.planned.fromDay")}</Label>
              <Input id={`${id}-from-day`} type="date" value={fromDay} onChange={e => setFromDay(e.target.value)} autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-through-day`}>{t("ui.planned.throughDay")}</Label>
              <Input id={`${id}-through-day`} type="date" value={throughDay} min={fromDay} onChange={e => setThroughDay(e.target.value)} />
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={`${id}-starts`}>{t("ui.planned.startsAt")}</Label>
              <Input id={`${id}-starts`} type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-ends`}>{t("ui.planned.endsAt")}</Label>
              <Input id={`${id}-ends`} type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} aria-invalid={invalidInterval} />
            </div>
          </div>
        )}
        <p className={invalidInterval ? "text-body-sm text-danger" : "text-body-sm text-muted-foreground"} role={invalidInterval ? "alert" : undefined}>
          {invalidInterval ? t("ui.planned.invalidInterval") : t("ui.planned.exclusiveEnd")}
        </p>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-note`}>{t("ui.planned.note")}</Label>
          <Textarea id={`${id}-note`} rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder={t("ui.planned.notePlaceholder")} />
        </div>
      </div>
      <DialogFooter className="gap-2">
        {onLogActual && !entry && (
          <Button type="button" variant="ghost" className="sm:mr-auto" onClick={() => { onClose(); onLogActual(); }}>
            {t("ui.planned.logActual")}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={!canSubmit}>{pending ? t("common.saving") : t(entry ? "ui.planned.update" : "ui.planned.create")}</Button>
      </DialogFooter>
    </form>
  );
}
