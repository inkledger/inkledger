import { useState } from "react";
import { Link } from "react-router";
import { currentPermission, PERMISSION_LABEL } from "@/lib/browserNotifications";
import { isNative } from "@/lib/native";
import { NotificationTester } from "@/components/settings/NotificationTester";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";

export function NotificationsSection() {
  const provider = useProviderName();
  const native = isNative();
  const [permission, setPermission] = useState(currentPermission);
  const request = async () => {
    if (typeof Notification === "undefined") {
      toast.error(t("settings.notifications.unsupported"));
      return;
    }
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") toast.success(t("settings.notifications.enabled"));
    else toast.error(t("settings.notifications.notGranted"));
  };

  return (
    <>
      <SettingsGroup
        id="notify-permission"
        title={t("settings.notifications.permissionTitle")}
        description={t("settings.notifications.permissionDescription", { provider })}
        keywords={t("settings.notifications.permissionKeywords")}
      >
        {native ? (
          <SettingsRow label={t("settings.notifications.appNotifications")} hint={t("settings.notifications.appHint")}>
            <Button variant="outline" size="sm" asChild>
              <Link to="/settings/permissions">{t("settings.notifications.goToPermissions")}</Link>
            </Button>
          </SettingsRow>
        ) : (
          <SettingsRow label={t("settings.notifications.browser")} hint={t("settings.notifications.state", { state: PERMISSION_LABEL[permission] ?? permission })}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void request()}
              disabled={permission === "unsupported" || permission === "granted"}
            >
              {t("settings.notifications.request")}
            </Button>
          </SettingsRow>
        )}
      </SettingsGroup>
      <SettingsGroup
        id="notify-test"
        title={t("settings.notifications.testTitle")}
        description={t("settings.notifications.testDescription", { provider })}
        keywords={t("settings.notifications.testKeywords")}
        collapsible
        defaultOpen={false}
      >
        <NotificationTester />
      </SettingsGroup>
    </>
  );
}
