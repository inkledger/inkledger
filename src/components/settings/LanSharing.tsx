import { toastError } from "@/lib/errorText";
import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { lanStart, lanStatus, lanStop, type LanStatus } from "@/lib/native";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { QrCode } from "@/components/app/QrCode";
import { CopyButton } from "@/components/app/CopyButton";
import { Step, Steps } from "@/components/app/Steps";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";

const isLoopback = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(host);

/**
 * Desktop app: share this Mac's server on the Wi-Fi, over HTTPS with the
 * app's own certificate (no Tailscale). A phone opens the welcome page
 * once to install the certificate, then uses the https addresses.
 */
export function LanSharing() {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const addHosts = trpc.info.addHosts.useMutation();
  const custom = trpc.info.get.useQuery().data?.customHosts ?? [];
  const local = isLoopback(window.location.hostname);

  useEffect(() => {
    void lanStatus().then(s => setStatus(s ?? null));
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        const s = await lanStart(custom);
        if (s) {
          // The server must answer to the names phones will use (the user's
          // DNS names are accepted already, from "How they reach you").
          const hosts = s.addresses.map(a => new URL(a).hostname).filter(h => !custom.includes(h));
          if (hosts.length) await addHosts.mutateAsync({ hosts });
          setStatus(s);
          toast.success(t("settings.lan.shared"));
        }
      } else {
        setStatus((await lanStop()) ?? null);
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const running = status?.running ?? false;
  return (
    <SettingsGroup
      id="devices-lan"
      title={t("settings.lan.title")}
      description={t("settings.lan.description")}
      keywords={t("settings.lan.keywords")}
    >
      <SettingsRow
        label={t("settings.lan.share")}
        htmlFor="lan"
        inline
        hint={
          local
            ? running
              ? t("settings.lan.on", { target: status?.target?.replace(/^https?:\/\//, "") ?? "" })
              : t("settings.lan.off")
            : t("settings.lan.remote")
        }
      >
        <Switch id="lan" checked={running} disabled={busy || !local} onCheckedChange={v => void toggle(v)} />
      </SettingsRow>

      {running && status && (
        <div className="mt-4 grid gap-6 border-t pt-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <Steps>
            <Step n={1} title={t("settings.lan.step1Title")}>
              {t("settings.lan.step1")}
              <span className="mt-2 flex flex-wrap items-center gap-2">
                <code className="rounded-md bg-muted px-2 py-1 text-body-sm text-foreground">{status.welcome}</code>
                {status.welcome && <CopyButton text={status.welcome} label={t("settings.lan.copy")} />}
              </span>
            </Step>
            <Step n={2} title={t("settings.lan.step2Title")}>
              {t("settings.lan.step2")}
              <ul className="mt-2 grid gap-1">
                {status.addresses.map(a => (
                  <li key={a} className="flex flex-wrap items-center gap-2">
                    <code className="rounded-md bg-muted px-2 py-1 text-body-sm text-foreground">{a}</code>
                    <CopyButton text={a} />
                  </li>
                ))}
              </ul>
            </Step>
            <Step n={3} title={t("settings.lan.step3Title")}>
              {t("settings.lan.step3")}
              <code className="mt-1 block break-all text-caption">{status.fingerprint}</code>
            </Step>
          </Steps>
          {status.welcome && (
            <figure className="grid justify-items-center gap-2 self-start">
              <span {...surface("picture")} className="flex rounded-lg">
                <QrCode value={status.welcome} label={t("settings.lan.qrLabel", { url: status.welcome })} className="h-44 w-44" />
              </span>
              <figcaption className="text-caption text-muted-foreground">{t("settings.lan.scan")}</figcaption>
            </figure>
          )}
          <p className="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-body-sm md:col-span-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {t("settings.lan.warning")}
          </p>
        </div>
      )}
    </SettingsGroup>
  );
}
