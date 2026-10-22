import { toastError, failureText, errorText } from "@/lib/errorText";
import { useState } from "react";
import { DatabaseBackup, FolderOpen, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { formatBytes } from "@/lib/devices";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { ErrorState } from "@/components/app/States";
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
import { Skeleton } from "@/components/ui/skeleton";
import { WEEKDAYS, type Schedule } from "@/lib/backupLabels";
import { toast } from "sonner";
import { dateFormat, t } from "@/i18n";

const schedules = (): { value: Schedule; label: string }[] => [
  { value: "off", label: t("settings.backup.off") },
  { value: "hourly", label: t("settings.backup.hourly") },
  { value: "daily", label: t("settings.backup.daily") },
  { value: "weekly", label: t("settings.backup.weekly") },
];
const when = (at: number | Date) =>
  dateFormat({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);

/** Settings → Backup: schedule, the folder, "Back up now", the list and restore. */
export function BackupSection() {
  const utils = trpc.useUtils();
  const info = trpc.backup.get.useQuery(undefined, { refetchInterval: 30_000 });
  const refresh = () => utils.backup.get.invalidate();
  const update = trpc.backup.update.useMutation({
    onSuccess: () => {
      void refresh();
      toast.success(t("settings.backup.scheduleSaved"));
    },
    onError: e => toastError(e),
  });
  const runNow = trpc.backup.run.useMutation({
    onSuccess: r => {
      void refresh();
      toast.success(t("settings.backup.created", { name: r.name }));
    },
    onError: e => {
      void refresh();
      toast.error(t("settings.backup.failed", { message: failureText(e) }));
    },
  });
  const admin = useAuth().user?.role === "admin";
  const restore = trpc.backup.restore.useMutation({
    onSuccess: r => {
      toast.success(t("settings.backup.restored"), { description: t("settings.backup.restoredHint", { safety: r.safety }) });
      setTimeout(() => window.location.reload(), 1200);
    },
    onError: e => toast.error(t("settings.backup.restoreFailed", { message: failureText(e) })),
  });
  const [restoring, setRestoring] = useState<string | null>(null);

  if (info.isPending) return <Skeleton className="m-6 h-64" />;
  if (info.error) return <ErrorState message={errorText(info.error)} onRetry={() => info.refetch()} />;
  const { settings, state, dir, writable, scheduled, next, files } = info.data;

  return (
    <>
      <SettingsGroup
        id="backup-schedule"
        title={t("settings.backup.scheduleTitle")}
        description={t("settings.backup.scheduleDescription")}
        keywords={t("settings.backup.scheduleKeywords")}
      >
        <SettingsRow label={t("settings.backup.frequency")}>
          <SegmentedControl label={t("settings.backup.frequency")} value={settings.schedule} onChange={v => update.mutate({ schedule: v })} options={schedules()} />
        </SettingsRow>
        {(settings.schedule === "daily" || settings.schedule === "weekly") && (
          <SettingsRow label={t("settings.backup.time")}>
            {settings.schedule === "weekly" && (
              <Select value={String(settings.weekday)} onValueChange={v => update.mutate({ weekday: Number(v) })}>
                <SelectTrigger className="w-36" aria-label={t("settings.backup.day")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((d, i) => (
                    <SelectItem key={d} value={String(i + 1)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input
              type="time"
              aria-label={t("settings.backup.timeLabel")}
              className="w-28"
              defaultValue={settings.time}
              onBlur={e => e.target.value && e.target.value !== settings.time && update.mutate({ time: e.target.value })}
            />
          </SettingsRow>
        )}
        <SettingsRow label={t("settings.backup.keep")} hint={t("settings.backup.keepHint")}>
          <Input
            type="number"
            min={1}
            max={365}
            aria-label={t("settings.backup.keepLabel")}
            className="w-24"
            defaultValue={settings.keep}
            onBlur={e => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 365 && n !== settings.keep) update.mutate({ keep: n });
            }}
          />
        </SettingsRow>
        <p className="mt-3 text-caption text-muted-foreground">
          {!scheduled
            ? t("settings.backup.remote")
            : next
              ? t("settings.backup.next", { when: when(next) })
              : t("settings.backup.autoOff")}
        </p>
      </SettingsGroup>

      <SettingsGroup id="backup-now" title={t("settings.backup.statusTitle")} keywords={t("settings.backup.statusKeywords")}>
        <SettingsRow
          label={t("settings.backup.lastOk")}
          hint={
            state.lastError && (!state.lastOkAt || (state.lastErrorAt ?? 0) > state.lastOkAt)
              ? t("settings.backup.lastFailed", { error: state.lastError })
              : state.lastOkAt
                ? when(state.lastOkAt)
                : t("settings.backup.none")
          }
        >
          <Button size="sm" disabled={runNow.isPending || !writable} onClick={() => runNow.mutate()}>
            <DatabaseBackup />
            {runNow.isPending ? t("settings.backup.running") : t("settings.backup.now")}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t("settings.backup.folder")}
          hint={writable ? t("settings.backup.folderHint") : t("settings.backup.folderDown")}
        >
          <span className="flex items-center gap-1.5 text-body-sm text-muted-foreground">
            <FolderOpen className="h-4 w-4" aria-hidden />
            <code>{dir}</code>
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        id="backup-files"
        title={t("settings.backup.savedTitle", { count: files.length })}
        keywords={t("settings.backup.savedKeywords")}
      >
        {files.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">{t("settings.backup.empty")}</p>
        ) : (
          <ul className="divide-y">
            {files.map(f => (
              <li key={f.name} className="flex items-center gap-3 py-2 first:pt-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{when(f.at)}</span>
                  <span className="block truncate text-caption text-muted-foreground">
                    {f.name} · {formatBytes(f.size)}
                  </span>
                </span>
                {/* Admins only: the backup's accounts come back with it. */}
                {admin && (
                  <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => setRestoring(f.name)}>
                    <RotateCcw />
                    {t("settings.backup.restore")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      <AlertDialog open={restoring !== null} onOpenChange={o => !o && setRestoring(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.backup.restoreTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.backup.restoreBody")}
            </AlertDialogDescription>
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
