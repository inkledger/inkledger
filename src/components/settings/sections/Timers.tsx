import { useEffect, useState } from "react";
import { Link } from "react-router";
import { idleDetectionSupported, requestIdlePermission } from "@/hooks/useIdleDetection";
import { useSettingsForm } from "@/hooks/useSettingsForm";
import { isNative } from "@/lib/native";
import { SettingField } from "@/components/settings/SettingField";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/app/States";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { t } from "@/i18n";

type IdleState = "unsupported" | "granted" | "prompt" | "denied";

export function TimersSection() {
  const { query, data, persist } = useSettingsForm();
  const native = isNative();
  const [systemIdle, setSystemIdle] = useState<IdleState>(() =>
    idleDetectionSupported() ? "prompt" : "unsupported"
  );
  useEffect(() => {
    if (!idleDetectionSupported()) return;
    void navigator.permissions
      .query({ name: "idle-detection" as PermissionName })
      .then(s => setSystemIdle(s.state))
      .catch(() => setSystemIdle("unsupported"));
  }, []);

  if (query.error)
    return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  if (!data) return <Skeleton className="m-6 h-48" />;

  return (
    <>
      <SettingsGroup
        id="timer-alerts"
        title={t("settings.timers.title")}
        description={t("settings.timers.description")}
        keywords={t("settings.timers.keywords")}
      >
        <SettingsRow
          label={native ? t("settings.timers.systemNotifications") : t("settings.timers.browserNotifications")}
          htmlFor="notify"
          inline
          hint={
            native ? (
              <>
                {t("settings.timers.permissionsIn")}{" "}
                <Link to="/settings/permissions" className="underline underline-offset-2">{t("settings.timers.permissionsLink")}</Link>.
              </>
            ) : (
              <>
                {t("settings.timers.browserPermissionIn")}{" "}
                <Link to="/settings/notifications" className="underline underline-offset-2">{t("settings.timers.notificationsLink")}</Link>.
              </>
            )
          }
        >
          <Switch
            id="notify"
            checked={data.notifyEnabled === 1}
            onCheckedChange={on => persist({ notifyEnabled: on ? 1 : 0 })}
          />
        </SettingsRow>
        {/* Stays editable with notifications off: never a stuck invalid value. */}
        <SettingField
          id="alert"
          label={t("settings.timers.threshold")}
          hint={t("settings.timers.range", { max: 720 })}
          field="timerAlertMinutes"
          server={data.timerAlertMinutes}
          inputMode="numeric"
          onSave={persist}
          className="mt-3 max-w-xs"
        />
      </SettingsGroup>

      <SettingsGroup
        id="timer-overlap"
        title={t("settings.timers.overlapTitle")}
        description={t("settings.timers.overlapDescription")}
        keywords={t("settings.timers.overlapKeywords")}
      >
        <SettingsRow label={t("settings.timers.overlapAllow")} htmlFor="overlap" inline hint={t("settings.timers.overlapHint")}>
          <Switch
            id="overlap"
            checked={data.overlapPolicy !== "block"}
            onCheckedChange={on => persist({ overlapPolicy: on ? "warn" : "block" })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        id="idle"
        title={t("settings.timers.idleTitle")}
        description={t("settings.timers.idleDescription")}
        keywords={t("settings.timers.idleKeywords")}
      >
        <SettingField
          id="idle-minutes"
          label={t("settings.timers.askAfter")}
          hint={t("settings.timers.range", { max: 240 })}
          field="idleMinutes"
          server={data.idleMinutes}
          inputMode="numeric"
          onSave={persist}
          className="max-w-xs"
        />
        {native ? (
          <p className="mt-3 text-body-sm text-muted-foreground">
            {t("settings.timers.nativeIdle")}
          </p>
        ) : (
          <SettingsRow
            className="mt-3 border-t pt-3"
            label={t("settings.timers.systemIdle")}
            hint={
              systemIdle === "granted"
                ? t("settings.timers.idleGranted")
                : systemIdle === "unsupported"
                  ? t("settings.timers.idleUnsupported")
                  : systemIdle === "denied"
                     ? t("settings.timers.idleDenied")
                    : t("settings.timers.idlePrompt")
            }
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={systemIdle === "unsupported" || systemIdle === "granted"}
              onClick={async () => {
                const ok = await requestIdlePermission();
                setSystemIdle(ok ? "granted" : "denied");
                if (ok) toast.success(t("settings.timers.idleOn"));
              }}
            >
              {t("settings.timers.enable")}
            </Button>
          </SettingsRow>
        )}
      </SettingsGroup>
    </>
  );
}
