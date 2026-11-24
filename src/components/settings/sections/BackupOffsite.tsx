import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { CloudUpload, FlaskConical, ListRestart, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { AppRouter } from "../../../../api/router";
import { trpc } from "@/lib/trpc";
import { dayAndTime } from "@/lib/dates";
import { formatBytes } from "@/lib/devices";
import { failureText, toastError } from "@/lib/errorText";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { SegmentedControl } from "@/components/app/SegmentedControl";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";

type Info = inferRouterOutputs<AppRouter>["backup"]["get"];
type Offsite = Info["offsite"];
type Kind = Offsite["kind"];
type LockMode = Offsite["objectLockMode"];

const kinds = (): { value: Kind; label: string }[] => [
  { value: "none", label: t("settings.backup.offsite.none") },
  { value: "s3", label: t("settings.backup.offsite.s3") },
  { value: "restic", label: t("settings.backup.offsite.restic") },
];

/** A whole number within bounds, else the fallback (what the field showed before). */
const whole = (raw: string, min: number, max: number, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/**
 * Settings → Backup, below the local backups: where off-site copies go and how the last
 * one went, the copies there (restorable by owners), and the restore drill. Loaded on
 * its own: most servers never open it.
 */
export default function BackupOffsite({ info, canRestore }: { info: Info; canRestore: boolean }) {
  const utils = trpc.useUtils();
  const refresh = () => utils.backup.get.invalidate();
  const saved = info.offsite;
  const [draft, setDraft] = useState<Offsite>(saved);
  const [secret, setSecret] = useState("");
  const set = <K extends keyof Offsite>(k: K, v: Offsite[K]) => setDraft(d => ({ ...d, [k]: v }));
  const dirty = secret !== "" || (Object.keys(saved) as (keyof Offsite)[]).some(k => saved[k] !== draft[k]);

  const save = trpc.backup.offsiteUpdate.useMutation({
    onSuccess: next => {
      setDraft(next);
      setSecret("");
      void refresh();
      toast.success(t("settings.backup.offsite.saved"));
    },
    onError: e => toastError(e),
  });
  const copyNow = trpc.backup.offsiteUpload.useMutation({
    onSuccess: r => {
      void refresh();
      toast.success(t("settings.backup.offsite.copied", { name: r.name ?? "" }));
    },
    onError: e => {
      void refresh();
      toast.error(t("settings.backup.offsite.copyFailed", { message: failureText(e) }));
    },
  });
  const [showCopies, setShowCopies] = useState(false);
  const copies = trpc.backup.offsiteList.useQuery(undefined, { enabled: showCopies && saved.kind !== "none", retry: false });
  const [restoring, setRestoring] = useState<string | null>(null);
  const restore = trpc.backup.offsiteRestore.useMutation({
    onSuccess: r => {
      toast.success(t("settings.backup.restored"), { description: t("settings.backup.restoredHint", { safety: r.safety }) });
      setTimeout(() => window.location.reload(), 1200);
    },
    onError: e => toast.error(t("settings.backup.restoreFailed", { message: failureText(e) })),
  });
  const drill = trpc.backup.drill.useMutation({
    onSuccess: () => {
      void refresh();
      toast.success(t("settings.backup.drill.done"));
    },
    onError: e => {
      void refresh();
      toast.error(t("settings.backup.drill.doneFailed", { message: failureText(e) }));
    },
  });
  const weekly = trpc.backup.drillUpdate.useMutation({ onSuccess: () => void refresh(), onError: e => toastError(e) });

  const state = info.offsiteState;
  const failedLast = state.lastError && (!state.lastOkAt || (state.lastErrorAt ?? 0) > state.lastOkAt);
  const environment =
    draft.kind === "s3"
      ? info.backupKeySet
        ? t("settings.backup.offsite.encrypted")
        : t("settings.backup.offsite.noKey")
      : draft.kind === "restic"
        ? info.resticConfigured
          ? t("settings.backup.offsite.resticEnv")
          : t("settings.backup.offsite.resticMissing")
        : null;
  const last = info.drill;

  return (
    <>
      <SettingsGroup
        id="backup-offsite"
        title={t("settings.backup.offsite.title")}
        description={t("settings.backup.offsite.description")}
        keywords={t("settings.backup.offsite.keywords")}
      >
        <SettingsRow label={t("settings.backup.offsite.kind")}>
          <SegmentedControl label={t("settings.backup.offsite.kind")} value={draft.kind} onChange={v => set("kind", v)} options={kinds()} />
        </SettingsRow>
        {draft.kind === "s3" && (
          <>
            <SettingsRow label={t("settings.backup.offsite.endpoint")} hint={t("settings.backup.offsite.endpointHint")}>
              <Input className="w-72 max-w-full" type="url" inputMode="url" aria-label={t("settings.backup.offsite.endpoint")} value={draft.endpoint} onChange={e => set("endpoint", e.target.value)} />
            </SettingsRow>
            <SettingsRow label={t("settings.backup.offsite.bucket")}>
              <Input className="w-56 max-w-full" aria-label={t("settings.backup.offsite.bucket")} value={draft.bucket} onChange={e => set("bucket", e.target.value)} />
            </SettingsRow>
            <SettingsRow label={t("settings.backup.offsite.prefix")}>
              <Input className="w-56 max-w-full" aria-label={t("settings.backup.offsite.prefix")} value={draft.prefix} onChange={e => set("prefix", e.target.value)} />
            </SettingsRow>
            <SettingsRow label={t("settings.backup.offsite.region")}>
              <Input className="w-40 max-w-full" aria-label={t("settings.backup.offsite.region")} value={draft.region} onChange={e => set("region", e.target.value)} />
            </SettingsRow>
            <SettingsRow label={t("settings.backup.offsite.accessKeyId")}>
              <Input className="w-56 max-w-full" autoComplete="off" aria-label={t("settings.backup.offsite.accessKeyId")} value={draft.accessKeyId} onChange={e => set("accessKeyId", e.target.value)} />
            </SettingsRow>
            <SettingsRow label={t("settings.backup.offsite.secret")} hint={saved.hasSecret ? t("settings.backup.offsite.secretKept") : undefined}>
              <Input className="w-56 max-w-full" type="password" autoComplete="new-password" aria-label={t("settings.backup.offsite.secret")} value={secret} onChange={e => setSecret(e.target.value)} />
            </SettingsRow>
            <SettingsRow label={t("settings.backup.offsite.lockDays")} hint={t("settings.backup.offsite.lockHint")}>
              <Input
                key={`lock:${draft.objectLockDays}`}
                className="w-24"
                type="number"
                min={0}
                max={3650}
                aria-label={t("settings.backup.offsite.lockDays")}
                defaultValue={draft.objectLockDays}
                onBlur={e => set("objectLockDays", whole(e.target.value, 0, 3650, draft.objectLockDays))}
              />
              {draft.objectLockDays > 0 && (
                <Select value={draft.objectLockMode} onValueChange={v => set("objectLockMode", v as LockMode)}>
                  <SelectTrigger className="w-36" aria-label={t("settings.backup.offsite.lockMode")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GOVERNANCE">{t("settings.backup.offsite.governance")}</SelectItem>
                    <SelectItem value="COMPLIANCE">{t("settings.backup.offsite.compliance")}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </SettingsRow>
          </>
        )}
        {draft.kind !== "none" && (
          <SettingsRow label={t("settings.backup.offsite.keep")} hint={t("settings.backup.offsite.keepHint")}>
            {(
              [
                ["keepDaily", 1, 365, t("settings.backup.offsite.keepDailyLabel"), t("settings.backup.offsite.keepDaily")],
                ["keepWeekly", 0, 520, t("settings.backup.offsite.keepWeeklyLabel"), t("settings.backup.offsite.keepWeekly")],
                ["keepMonthly", 0, 240, t("settings.backup.offsite.keepMonthlyLabel"), t("settings.backup.offsite.keepMonthly")],
              ] as const
            ).map(([k, min, max, label, short]) => (
              <label key={k} className="flex items-center gap-1.5 text-body-sm text-muted-foreground">
                {short}
                <Input
                  key={`${k}:${draft[k]}`}
                  className="w-20"
                  type="number"
                  min={min}
                  max={max}
                  aria-label={label}
                  defaultValue={draft[k]}
                  onBlur={e => set(k, whole(e.target.value, min, max, draft[k]))}
                />
              </label>
            ))}
          </SettingsRow>
        )}
        {environment && <p className="mt-3 text-caption text-muted-foreground [overflow-wrap:anywhere]">{environment}</p>}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate({ ...draft, ...(secret ? { secret } : {}) })}>
            {t("settings.backup.offsite.save")}
          </Button>
        </div>
      </SettingsGroup>

      {saved.kind !== "none" && (
        <SettingsGroup id="backup-offsite-status" title={t("settings.backup.offsite.copiesTitle")} keywords={t("settings.backup.offsite.copiesKeywords")}>
          <SettingsRow
            label={t("settings.backup.offsite.last")}
            hint={
              failedLast
                ? t("settings.backup.offsite.lastFailed", { error: state.lastError ?? "" })
                : state.lastOkAt
                  ? t("settings.backup.offsite.lastOk", { when: dayAndTime(state.lastOkAt), name: state.lastName ?? "" })
                  : t("settings.backup.offsite.never")
            }
          >
            <Button size="sm" variant="outline" disabled={copyNow.isPending || info.files.length === 0} onClick={() => copyNow.mutate()}>
              <CloudUpload />
              {copyNow.isPending ? t("settings.backup.offsite.copying") : t("settings.backup.offsite.now")}
            </Button>
          </SettingsRow>
          {!showCopies ? (
            <Button size="sm" variant="ghost" onClick={() => setShowCopies(true)}>
              <ListRestart />
              {t("settings.backup.offsite.showCopies")}
            </Button>
          ) : copies.isPending ? (
            <p className="text-body-sm text-muted-foreground">{t("settings.backup.offsite.copying")}</p>
          ) : copies.error ? (
            <p className="text-body-sm text-destructive [overflow-wrap:anywhere]">{failureText(copies.error)}</p>
          ) : copies.data.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">{t("settings.backup.offsite.copiesEmpty")}</p>
          ) : (
            <ul className="divide-y">
              {copies.data.slice(0, 30).map(c => (
                <li key={c.name} className="flex items-center gap-3 py-2 first:pt-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.at ? dayAndTime(c.at) : c.name}</span>
                    <span className="block truncate text-caption text-muted-foreground">
                      {c.name}
                      {c.size !== null ? ` · ${formatBytes(c.size)}` : ""}
                    </span>
                  </span>
                  {canRestore && (
                    <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => setRestoring(c.name)}>
                      <RotateCcw />
                      {t("settings.backup.restore")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SettingsGroup>
      )}

      <SettingsGroup
        id="backup-drill"
        title={t("settings.backup.drill.title")}
        description={t("settings.backup.drill.description")}
        keywords={t("settings.backup.drill.keywords")}
      >
        <SettingsRow
          label={t("settings.backup.drill.last")}
          hint={
            !last
              ? t("settings.backup.drill.never")
              : last.ok
                ? t("settings.backup.drill.passed", { when: dayAndTime(last.at), users: last.users ?? 0, worklogs: last.worklogs ?? 0, connections: last.connections ?? 0 })
                : t("settings.backup.drill.failed", { when: dayAndTime(last.at), error: last.error ?? "" })
          }
        >
          <Button size="sm" variant="outline" disabled={drill.isPending || info.files.length === 0} onClick={() => drill.mutate()}>
            <FlaskConical />
            {drill.isPending ? t("settings.backup.drill.running") : t("settings.backup.drill.run")}
          </Button>
        </SettingsRow>
        <SettingsRow label={t("settings.backup.drill.weekly")} hint={t("settings.backup.drill.weeklyHint")}>
          <Switch aria-label={t("settings.backup.drill.weekly")} checked={info.drillSettings.weekly} disabled={weekly.isPending} onCheckedChange={v => weekly.mutate({ weekly: v })} />
        </SettingsRow>
      </SettingsGroup>

      <AlertDialog open={restoring !== null} onOpenChange={o => !o && setRestoring(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.backup.offsite.restoreTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.backup.offsite.restoreBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => restoring && restore.mutate({ name: restoring })}>{t("settings.backup.restore")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
