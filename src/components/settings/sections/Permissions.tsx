import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import {
  busyLabel,
  isNative,
  notificationPermission,
  notifyNative,
  openSystemSettings,
  requestNotificationPermission,
  setAutostart,
  type NativeInfo,
  type NativePermission,
  type SettingsPane,
} from "@/lib/native";
import { useNativeInfo } from "@/hooks/useNativeInfo";
import { Kbd } from "@/components/app/Kbd";
import { SettingsDisclosure, SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";

type Tone = "ok" | "warn" | "off" | "info";

const notifyStatus = (): Record<NativePermission, { label: string; tone: Tone }> => ({
  granted: { label: t("settings.permissions.granted"), tone: "ok" },
  denied: { label: t("settings.permissions.denied"), tone: "warn" },
  prompt: { label: t("settings.permissions.prompt"), tone: "warn" },
  // macOS doesn't tell apps: it decides, and Settings shows it.
  unknown: { label: t("settings.permissions.unknown"), tone: "info" },
});

/** Desktop systems whose settings panes the app can open. */
const CAN_OPEN_SETTINGS = new Set(["macos", "windows"]);


/**
 * Native app: every system permission with its state and the one action
 * that fixes it, launch at login, and a short guide per platform.
 */
export function PermissionsSection() {
  const provider = useProviderName();
  const [info, setInfo] = useNativeInfo();
  const [notify, setNotify] = useState<NativePermission | null>(null);
  const native = isNative();
  useEffect(() => {
    if (native) void notificationPermission().then(p => setNotify(p ?? null));
  }, [native]);

  const canOpen = info !== null && CAN_OPEN_SETTINGS.has(info.platform);
  const open = (pane: SettingsPane) =>
    openSystemSettings(pane).catch((e: unknown) => toast.error(String(e)));
  const busyShortcuts = info?.shortcuts.filter(s => !s.ok) ?? [];
  const notifyState = notifyStatus()[notify ?? "unknown"];

  const toggleAutostart = async (enabled: boolean) => {
    try {
      await setAutostart(enabled);
      setInfo(i => (i ? { ...i, autostart: enabled } : i));
    } catch (e) {
      toast.error(t("settings.permissions.autostartFailed", { error: String(e) }));
    }
  };

  const testNotification = async () => {
    try {
      await notifyNative("inkledger", t("settings.permissions.testBody"));
      toast.success(t("settings.permissions.sent"), {
        description: t("settings.permissions.sentHint"),
      });
    } catch (e) {
      toast.error(t("settings.permissions.sendFailed", { error: String(e) }));
    }
  };

  const askNotifications = async () => {
    const p = await requestNotificationPermission();
    if (p) setNotify(p);
  };

  return (
    <>
      {info?.desktop && (
        <SettingsGroup id="permissions-login" title={t("settings.permissions.startup")} keywords={t("settings.permissions.startupKeywords")}>
          <SettingsRow
            label={t("settings.permissions.openAtLogin")}
            htmlFor="autostart"
            inline
            hint={t("settings.permissions.openAtLoginHint")}
          >
            <Switch
              id="autostart"
              checked={info.autostart ?? false}
              disabled={info.autostart === null}
              onCheckedChange={v => void toggleAutostart(v)}
            />
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup
        id="permissions-system"
        title={t("settings.permissions.systemTitle")}
        keywords={t("settings.permissions.systemKeywords")}
      >
        <div className="grid gap-3">
          <PermissionRow
            title={t("settings.permissions.notifications")}
            state={notifyState.label}
            tone={notifyState.tone}
            hint={
              notify === "unknown"
                ? t("settings.permissions.unknownHint")
                : t("settings.permissions.notificationsHint", { provider })
            }
          >
            {(notify === "prompt" || notify === "denied") && (
              <Button variant="outline" size="sm" onClick={() => void askNotifications()}>
                {t("settings.permissions.ask")}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void testNotification()}>
              {t("settings.permissions.test")}
            </Button>
            {canOpen && <SettingsLink onClick={() => void open("notifications")}>{t("settings.permissions.notificationSettings")}</SettingsLink>}
          </PermissionRow>

          {info?.desktop && (
            <PermissionRow
              title={t("settings.permissions.loginStart")}
              state={info.autostart ? t("settings.permissions.on") : t("settings.permissions.off")}
              tone={info.autostart ? "ok" : "off"}
              hint={t("settings.permissions.loginStartHint")}
            >
              {canOpen && <SettingsLink onClick={() => void open("login-items")}>{t("settings.permissions.loginItems")}</SettingsLink>}
            </PermissionRow>
          )}

          {info?.desktop && (
            <PermissionRow
              title={t("settings.permissions.globalShortcuts")}
              state={busyLabel(busyShortcuts.length)}
              tone={busyShortcuts.length ? "warn" : "ok"}
              hint={t("settings.permissions.globalShortcutsHint")}
            >
              <ul className="grid w-full gap-1 text-body-sm">
                {info.shortcuts.map(s => (
                  <li key={s.keys} className="flex items-center gap-3">
                    <Kbd>{s.keys}</Kbd>
                    <span>{s.label}</span>
                    {!s.ok && <span className="text-caption text-warning">{t("settings.permissions.takenByOther")}</span>}
                  </li>
                ))}
              </ul>
              {canOpen && busyShortcuts.length > 0 && (
                <SettingsLink onClick={() => void open("keyboard")}>{t("settings.permissions.systemShortcuts")}</SettingsLink>
              )}
            </PermissionRow>
          )}

          {info?.desktop && (
            <PermissionRow
              title={t("settings.permissions.idle")}
              state={t("settings.permissions.active")}
              tone="ok"
              hint={t("settings.permissions.idleHint")}
            />
          )}

          {canOpen && (
            <PermissionRow
              title={t("settings.permissions.focus")}
              state={t("settings.permissions.fromSystem")}
              tone="info"
              hint={t("settings.permissions.focusHint")}
            >
              <SettingsLink onClick={() => void open("focus")}>{t("settings.permissions.focusLink")}</SettingsLink>
            </PermissionRow>
          )}
        </div>
        {info && <PermissionsGuide platform={info.platform} />}
      </SettingsGroup>
    </>
  );
}

function PermissionRow({
  title,
  state,
  tone,
  hint,
  children,
}: {
  title: string;
  state: string;
  tone: Tone;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{title}</span>
        <span
          className={cn(
            "flex items-center gap-1.5 text-caption",
            tone === "ok" && "text-success",
            tone === "warn" && "text-warning",
            (tone === "off" || tone === "info") && "text-muted-foreground"
          )}
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
          {state}
        </span>
      </div>
      <p className="mt-1 text-caption text-muted-foreground">{hint}</p>
      {children && <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function SettingsLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      {children}
      <ExternalLink />
    </Button>
  );
}

/** Where each permission lives, per system: for when something doesn't work. */
const guide = (platform: NativeInfo["platform"]): { title: string; steps: string[] } => {
  switch (platform) {
    case "macos":
      return {
        title: "macOS",
        steps: [
          t("settings.permissions.guide.macos1"),
          t("settings.permissions.guide.macos2"),
          t("settings.permissions.guide.macos3"),
          t("settings.permissions.guide.macos4"),
          t("settings.permissions.guide.macos5"),
        ],
      };
    case "windows":
      return {
        title: "Windows",
        steps: [
          t("settings.permissions.guide.windows1"),
          t("settings.permissions.guide.windows2"),
          t("settings.permissions.guide.windows3"),
          t("settings.permissions.guide.windows4"),
        ],
      };
    case "linux":
      return {
        title: "Linux",
        steps: [t("settings.permissions.guide.linux1"), t("settings.permissions.guide.linux2")],
      };
    case "ios":
      return {
        title: "iPhone",
        steps: [
          t("settings.permissions.guide.ios1"),
          t("settings.permissions.guide.ios2"),
          t("settings.permissions.guide.network"),
        ],
      };
    case "android":
      return {
        title: "Android",
        steps: [
          t("settings.permissions.guide.android1"),
          t("settings.permissions.guide.android2"),
          t("settings.permissions.guide.network"),
        ],
      };
  }
};

function PermissionsGuide({ platform }: { platform: NativeInfo["platform"] }) {
  const info = guide(platform);
  return (
    <SettingsDisclosure
      id="permissions-guide"
      title={t("settings.permissions.guideTitle", { platform: info.title })}
      keywords={t("settings.permissions.guideKeywords")}
    >
      <ol className="grid list-decimal gap-1.5 pl-5 text-body-sm text-muted-foreground">
        {info.steps.map(s => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="mt-2 text-caption text-muted-foreground">
        {t("settings.permissions.guideFooter")}
      </p>
    </SettingsDisclosure>
  );
}
