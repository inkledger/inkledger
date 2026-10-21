import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { invalidateJiraData } from "@/hooks/useSync";
import { relativeFormat, t } from "@/i18n";

/** "just now", "2 minutes ago", "1 hour ago". */
function ago(date: Date, now: number): string {
  const min = Math.round((now - date.getTime()) / 60_000);
  if (min < 1) return t("ui.layout.now");
  if (min < 60) return relativeFormat().format(-min, "minute");
  return relativeFormat().format(-Math.round(min / 60), "hour");
}

/**
 * The server syncs with Jira in the background: poll its status and refresh
 * local data whenever a newer sync landed.
 */
function useSyncStatus() {
  const utils = trpc.useUtils();
  // Checked every 30s even in a background tab, and again on coming back:
  // a sync landed every 5 min reaches the lists within half a minute.
  const status = trpc.issues.syncStatus.useQuery(undefined, {
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: "always",
  });
  const last = status.data?.lastSyncAt?.getTime() ?? null;
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (last === null) return;
    if (seen.current !== null && last > seen.current) invalidateJiraData(utils);
    seen.current = last;
  }, [last, utils]);
  return status.data;
}

/** Last background sync as a short hint ("Updated 2 minutes ago"), and its error. */
export function useSyncHint() {
  const status = useSyncStatus();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);
  const hint = status?.lastError
    ? t("ui.layout.syncFailed")
    : status?.lastSyncAt
      ? t("ui.layout.updated", {
          when: ago(status.lastSyncAt, Math.max(now, status.lastSyncAt.getTime())),
        })
      : null;
  return { hint, error: status?.lastError ?? null };
}
