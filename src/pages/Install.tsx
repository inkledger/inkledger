import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Clock, Download, Smartphone } from "lucide-react";
import { DOWNLOADS_PATH, type DownloadsManifest } from "@contracts/downloads";
import { formatDate } from "@contracts/time";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { detectPlatform, formatBytes, type DevicePlatform } from "@/lib/devices";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { CopyButton } from "@/components/app/CopyButton";
import { Step, Steps } from "@/components/app/Steps";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

const PLATFORMS: { value: DevicePlatform; label: string }[] = [
  { value: "android", label: "Android" },
  { value: "ios", label: "iPhone" },
  { value: "desktop", label: "Computer" },
];

/**
 * Public page a new device opens (link or QR from Info): no login, only
 * reachable from the tailnet or this machine. Android downloads the app;
 * iPhone adds the web app to the Home screen; both end on "add this server".
 */
export default function Install() {
  useDocumentTitle(t("pages.install.title"));
  const [platform, setPlatform] = useState<DevicePlatform>(() =>
    detectPlatform(navigator.userAgent, navigator.maxTouchPoints)
  );
  const [manifest, setManifest] = useState<DownloadsManifest | null>(null);
  useEffect(() => {
    void fetch(`${DOWNLOADS_PATH}/manifest.json`)
      .then(r => (r.ok ? (r.json() as Promise<DownloadsManifest>) : { android: null }))
      .then(setManifest)
      .catch(() => setManifest({ android: null }));
  }, []);
  const server = window.location.host;
  const android = manifest?.android;
  // Opened on the Wi-Fi (the desktop app's local sharing), not via Tailscale.
  const lan = /\.local$|^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(window.location.hostname);
  const reach = lan
    ? { title: t("pages.install.lanTitle"), text: t("pages.install.lanText") }
    : { title: t("pages.install.tailscaleTitle"), text: t("pages.install.tailscaleText") };

  return (
    <main className="min-h-dvh bg-canvas px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mx-auto grid max-w-lg gap-4">
        <header className="grain cover-sunset flex items-center gap-3 rounded-xl p-5 text-cover-title">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-action text-action-foreground">
            <Clock className="h-6 w-6" strokeWidth={2.25} aria-hidden />
          </span>
          <div>
            <h1 className="font-display text-title">{t("pages.install.title")}</h1>
            <p className="text-body-sm opacity-80">{t("pages.install.tagline")}</p>
          </div>
        </header>

        <section className="rounded-xl border bg-card p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="font-medium">{t("pages.install.whichDevice")}</p>
            <SegmentedControl label={t("pages.install.device")} value={platform} onChange={setPlatform} options={PLATFORMS} />
          </div>

          {platform === "android" && (
            <Steps>
              <Step n={1} title={reach.title}>
                {reach.text}
              </Step>
              <Step n={2} title={t("pages.install.android.download")}>
                {android ? (
                  <div className="mt-2 grid gap-1">
                    <Button asChild className="w-fit">
                      <a href={`${DOWNLOADS_PATH}/${android.file}`} download>
                        <Download />
                        {t("pages.install.android.downloadButton")}
                      </a>
                    </Button>
                    <span className="text-caption text-muted-foreground">
                      {t("pages.install.android.build", {
                        version: android.version,
                        size: formatBytes(android.size),
                        date: formatDate(android.builtAt, "long"),
                      })}
                    </span>
                  </div>
                ) : manifest ? (
                  <span className="text-warning">
                    {t("pages.install.android.unpublished")}
                  </span>
                ) : (
                  t("pages.install.android.checking")
                )}
              </Step>
              <Step n={3} title={t("pages.install.android.installTitle")}>
                {t("pages.install.android.installText")}
              </Step>
              <Step n={4} title={t("pages.install.addServer")}>
                <ServerToCopy server={server} />
              </Step>
            </Steps>
          )}

          {platform === "ios" && (
            <Steps>
              <Step n={1} title={t("pages.install.ios.safariTitle")}>
                {t("pages.install.ios.safariText")}
              </Step>
              <Step n={2} title={t("pages.install.ios.homeTitle")}>
                {t("pages.install.ios.homeText")}
              </Step>
              <Step n={3} title={t("pages.install.ios.openTitle")}>
                {t("pages.install.ios.openText")}
              </Step>
              <p className="rounded-lg bg-muted p-3 text-caption text-muted-foreground">
                {t("pages.install.ios.note")}
              </p>
            </Steps>
          )}

          {platform === "desktop" && (
            <Steps>
              <Step n={1} title={t("pages.install.desktop.browserTitle")}>
                {t("pages.install.desktop.browserText")}{" "}
                <Link to="/" className="underline underline-offset-2">
                  {t("pages.install.desktop.openTempo")}
                </Link>
              </Step>
              <Step n={2} title={t("pages.install.desktop.appTitle")}>
                {t("pages.install.desktop.appText")}
                <ServerToCopy server={server} />
              </Step>
            </Steps>
          )}
        </section>

        <p className="flex items-center justify-center gap-1.5 text-caption text-muted-foreground">
          <Smartphone className="h-3.5 w-3.5" aria-hidden />
          {lan ? t("pages.install.footerLan") : t("pages.install.footerTailscale")}
        </p>
      </div>
    </main>
  );
}

function ServerToCopy({ server }: { server: string }) {
  return (
    <span className="mt-2 flex flex-wrap items-center gap-2">
      <code className="rounded-md bg-muted px-2 py-1 text-body-sm text-foreground">{server}</code>
      <CopyButton text={server} />
    </span>
  );
}
