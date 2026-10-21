import type { ReactNode } from "react";
import { Link } from "react-router";
import { Laptop, Smartphone } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatDate } from "@contracts/time";
import { formatBytes, installUrl } from "@/lib/devices";
import { isNative } from "@/lib/native";
import { PageHeader } from "@/components/app/PageHeader";
import { PanelRow, PanelSection } from "@/components/app/Panel";
import { CopyButton } from "@/components/app/CopyButton";
import { ErrorState } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";

/**
 * Info: this server's addresses, the apps it offers, and how to reach it
 * with or without Tailscale. Adding a device lives in the desktop app's
 * Settings → Dispositivi; here only a pointer.
 */
export default function Info() {
  const info = trpc.info.get.useQuery();
  const hosts = info.data?.tailnetOrigins ?? [];
  const android = info.data?.downloads.android;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  const link = installUrl(hosts, window.location.origin);

  if (info.isPending || info.error)
    return (
      <>
        <PageHeader title={t("pages.info.title")} description={t("pages.info.description")} />
        {info.error ? (
          <ErrorState message={info.error.message} onRetry={() => void info.refetch()} />
        ) : (
          <Skeleton className="m-6 h-64" />
        )}
      </>
    );

  return (
    <>
      <PageHeader title={t("pages.info.title")} description={t("pages.info.description")} />
      <PanelRow className="xl:grid-cols-2">
        <div className="min-w-0 border-b xl:border-b-0 xl:border-r">
          <PanelSection title={t("pages.info.server")} className="border-b">
            <dl className="grid gap-3 text-body-sm">
              {hosts.map(h => (
                <Address key={h} label={t("pages.info.tailscaleHost")} value={h} icon={<Smartphone className="h-4 w-4" />} />
              ))}
              <Address
                label={local ? t("pages.info.onThisComputer") : t("pages.info.openNow")}
                value={window.location.host}
                icon={<Laptop className="h-4 w-4" />}
              />
            </dl>
          </PanelSection>
          <PanelSection title={t("pages.info.apps")}>
            <dl className="grid gap-2 text-body-sm sm:grid-cols-[7rem_1fr]">
              <dt className="text-muted-foreground">Android</dt>
              <dd>
                {android
                  ? t("pages.info.androidBuild", {
                      version: android.version,
                      size: formatBytes(android.size),
                      date: formatDate(android.builtAt, "long"),
                    })
                  : t("pages.info.notPublished")}
              </dd>
              <dt className="text-muted-foreground">iPhone</dt>
              <dd>{t("pages.info.iphone")}</dd>
              <dt className="text-muted-foreground">{t("pages.info.desktopApp")}</dt>
              <dd>{isNative() ? t("pages.info.usingApp") : t("pages.info.desktopOrBrowser")}</dd>
            </dl>
          </PanelSection>
        </div>

        <div className="min-w-0">
          <PanelSection title={t("pages.info.addDevice")} className="border-b">
            <p className="text-body-sm text-muted-foreground">
              {t("pages.info.addDeviceText")}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="break-all rounded-md bg-muted px-2 py-1 text-body-sm">{link}</code>
              <CopyButton text={link} label={t("pages.info.copyLink")} />
            </div>
            {isNative() && (
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link to="/settings/devices">{t("pages.info.openDevices")}</Link>
              </Button>
            )}
          </PanelSection>
          <PanelSection title={t("pages.info.noTailscale")}>
            <p className="text-body-sm text-muted-foreground">
              {t("pages.info.noTailscale1")}{" "}
              {local && (
                <>
                  {t("pages.info.noTailscaleHere")} <code className="text-foreground">{window.location.host}</code>{" "}
                </>
              )}
              {t("pages.info.noTailscale2")}
            </p>
          </PanelSection>
        </div>
      </PanelRow>
    </>
  );
}

function Address({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" {...surface("picture")}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-caption text-muted-foreground">{label}</dt>
        <dd className="truncate font-medium">{value}</dd>
      </div>
      <CopyButton text={value} />
    </div>
  );
}
