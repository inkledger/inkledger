import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { formatDate } from "@contracts/time";
import { formatBytes, installUrl } from "@/lib/devices";
import {
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/SettingsGroup";
import { QrCode } from "@/components/app/QrCode";
import { CopyButton } from "@/components/app/CopyButton";
import { Step, Steps } from "@/components/app/Steps";
import { ErrorState } from "@/components/app/States";
import { Skeleton } from "@/components/ui/skeleton";
import { LanSharing } from "@/components/settings/LanSharing";
import { DeviceAccess } from "@/components/settings/DeviceAccess";
import { surface } from "@/components/app/surface";

/**
 * Desktop app: add a phone or another computer. Steps and a QR to the
 * public install page on the server's Tailscale name (a phone can't reach
 * localhost), and the app builds it offers.
 */
export function DevicesSection() {
  const info = trpc.info.get.useQuery();
  if (info.isPending) return <Skeleton className="m-6 h-64" />;
  if (info.error)
    return (
      <ErrorState message={info.error.message} onRetry={() => info.refetch()} />
    );
  const hosts = info.data.tailnetOrigins;
  const link = installUrl(hosts, window.location.origin);
  const android = info.data.downloads.android;

  return (
    <>
      <DeviceAccess />

      {hosts.length > 0 && (
        <SettingsGroup
          id="devices-add"
          title={t("settings.devices.tailscaleTitle")}
          description={t("settings.devices.tailscaleDescription")}
          keywords={t("settings.devices.tailscaleKeywords")}
        >
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto]">
            <Steps>
              <Step n={1} title={t("settings.devices.step1Title")}>
                {t("settings.devices.step1")}
              </Step>
              <Step n={2} title={t("settings.devices.step2Title")}>
                {t("settings.devices.step2")}
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="break-all rounded-md bg-muted px-2 py-1 text-body-sm text-foreground">
                    {link}
                  </code>
                  <CopyButton text={link} label={t("settings.devices.copyLink")} />
                </span>
              </Step>
              <Step n={3} title={t("settings.devices.step3Title")}>
                <strong className="font-medium text-foreground">
                  Android:
                </strong>{" "}
                {t("settings.devices.step3Android")}{" "}
                <strong className="font-medium text-foreground">iPhone:</strong>{" "}
                {t("settings.devices.step3Iphone")}
              </Step>
              <Step n={4} title={t("settings.devices.step4Title")}>
                {t("settings.devices.step4")}
              </Step>
            </Steps>
            <figure className="grid justify-items-center gap-2 self-start">
              <span {...surface("picture")} className="flex rounded-lg">
                <QrCode
                  value={link}
                  label={t("settings.lan.qrLabel", { url: link })}
                  className="h-44 w-44"
                />
              </span>
              <figcaption className="text-caption text-muted-foreground">
                {t("settings.lan.scan")}
              </figcaption>
            </figure>
          </div>
        </SettingsGroup>
      )}

      <LanSharing />

      <SettingsGroup
        id="devices-builds"
        title={t("settings.devices.buildsTitle")}
        keywords={t("settings.devices.buildsKeywords")}
      >
        <SettingsRow
          label="Android"
          hint={
            android
              ? t("settings.devices.androidVersion", {
                  version: android.version,
                  size: formatBytes(android.size),
                  date: formatDate(android.builtAt, "long"),
                })
              : t("settings.devices.notPublished")
          }
        />
        <SettingsRow
          label="iPhone"
          hint={t("settings.devices.iphoneHint")}
        />
      </SettingsGroup>
    </>
  );
}
