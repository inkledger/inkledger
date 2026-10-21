import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { notificationTitle } from "@/hooks/useNotifications";
import { kindTitle } from "@/components/notifications/kindTitle";
import { timerAlertText } from "@/hooks/useTimerAlerts";
import {
  currentPermission,
  PERMISSION_LABEL,
  showBrowserNotification,
  type ShowResult,
} from "@/lib/browserNotifications";
import {
  NOTIFICATION_KINDS,
  type NotificationKind,
} from "@contracts/notifications";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Follows the browser permission, also when it is granted from the form. */
function usePermission(): string {
  const [permission, setPermission] = useState(currentPermission);
  useEffect(() => {
    let status: PermissionStatus | null = null;
    const sync = () => setPermission(currentPermission());
    void navigator.permissions
      ?.query({ name: "notifications" })
      .then(s => {
        status = s;
        s.onchange = sync;
      })
      .catch(() => undefined);
    window.addEventListener("focus", sync);
    return () => {
      if (status) status.onchange = null;
      window.removeEventListener("focus", sync);
    };
  }, []);
  return permission;
}

/**
 * Settings → notification tests: fires each kind of notification on demand, through the same
 * paths as the real ones (fake rows in the local DB, never Jira).
 */
export function NotificationTester() {
  const provider = useProviderName();
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  const permission = usePermission();
  const [kind, setKind] = useState<NotificationKind>("assigned");
  const refresh = () => {
    void utils.notifications.list.invalidate();
    void utils.notifications.count.invalidate();
  };

  const create = trpc.notifications.createTest.useMutation({
    onSuccess: ({ issueKey }) => {
      refresh();
      toast.success(t("settings.tester.created", { issueKey }), {
        description: t("settings.tester.createdHint"),
      });
    },
    onError: e => toast.error(t("settings.tester.createFailed", { message: e.message })),
  });
  const clear = trpc.notifications.dismissAll.useMutation({
    onSuccess: ({ dismissed }) => {
      refresh();
      toast.success(t("settings.tester.archived", { count: dismissed }));
    },
    onError: e => toast.error(t("settings.tester.archiveFailed", { message: e.message })),
  });

  // The real browser notification shows only with the tab in background:
  // a delayed create leaves time to switch tab.
  const [delayed, setDelayed] = useState(false);
  const timeout = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timeout.current), []);
  const createLater = () => {
    setDelayed(true);
    toast(t("settings.tester.switchTab"));
    timeout.current = window.setTimeout(() => {
      setDelayed(false);
      create.mutate({ kind });
    }, 10_000);
  };

  const granted = permission === "granted";
  const notifyEnabled = settings.data?.notifyEnabled === 1;
  const thresholdMinutes = settings.data?.timerAlertMinutes || 60;

  const report = (result: ShowResult) => {
    if (result === "error")
      toast.error(t("settings.tester.refused"), {
        description: t("settings.tester.refusedHint"),
      });
    else
      toast.success(
        result === "shown"
          ? t("settings.tester.delivered")
          : t("settings.tester.sent"),
        {
          description:
            t("settings.tester.notSeen"),
          duration: 12_000,
        },
      );
  };
  // A fresh tag per click: reusing one replaces the previous silently, no banner.
  const tag = () => `ikl-test-${Date.now()}`;

  const browserTest = async () => {
    report(
      await showBrowserNotification(
        notificationTitle({ kind, issueKey: "TEST-1", detail: "Critica" }),
        { body: t("settings.tester.testBody"), tag: tag() },
      ),
    );
  };
  const timerTest = async () => {
    const { title, body } = timerAlertText(
      "TEST-1",
      thresholdMinutes * 60 + 60,
      thresholdMinutes,
    );
    report(await showBrowserNotification(title, { body, tag: tag() }));
  };

  return (
    <div className="grid gap-5">
      <p className="-mt-3 text-body-sm text-muted-foreground">
        {t("settings.tester.intro", { provider })}
      </p>

      <div className="grid gap-3">
        <div className="grid justify-items-start gap-2">
          <Label htmlFor="test-kind">{t("settings.tester.kind")}</Label>
          <Select
            value={kind}
            onValueChange={v => setKind(v as NotificationKind)}
          >
            <SelectTrigger id="test-kind" size="sm" className="min-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTIFICATION_KINDS.map(k => (
                <SelectItem key={k} value={k}>
                  {k === "priority" ? t("settings.tester.critical", { title: kindTitle(k) }) : kindTitle(k)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={create.isPending}
            onClick={() => create.mutate({ kind })}
          >
            {t("settings.tester.create")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={create.isPending || delayed}
            onClick={createLater}
          >
            {delayed ? t("settings.tester.arriving") : t("settings.tester.createLater")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!granted}
            onClick={() => void browserTest()}
          >
            {t("settings.tester.browser")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!granted}
            onClick={() => void timerTest()}
          >
            {t("settings.tester.timer")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
          >
            {t("settings.tester.archiveAll")}
          </Button>
        </div>
      </div>

      <dl className="grid gap-2 border-t pt-4 text-body-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">{t("settings.tester.permission")}</dt>
        <dd>{PERMISSION_LABEL[permission] ?? permission}</dd>
        <dt className="text-muted-foreground">{t("settings.tester.browserNotifications")}</dt>
        <dd>
          {notifyEnabled
            ? t("settings.tester.browserOn")
            : t("settings.tester.browserOff")}
        </dd>
      </dl>
      {!granted && (
        <p className="-mt-2 text-caption text-muted-foreground">
          {t("settings.tester.needPermission")}
        </p>
      )}
    </div>
  );
}
