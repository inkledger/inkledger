import { useEffect, useState } from "react";
import { Check, Globe, Plus, RefreshCw, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { isNative, openExternal, tailscaleInfo, tailscaleServe, type TailscaleInfo } from "@/lib/native";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { t } from "@/i18n";

const loopbackPort = () => {
  const { hostname, port, protocol } = window.location;
  return /^(localhost|127\.\d+\.\d+\.\d+)$/.test(hostname) && protocol === "http:" ? Number(port || 80) : null;
};

/**
 * Settings → Devices: how other devices reach this server — chosen
 * here, after setup, not in config files. Tailscale (detected on this Mac,
 * Serve turned on from the app) or names on the user's own DNS.
 */
export function DeviceAccess() {
  const utils = trpc.useUtils();
  const info = trpc.info.get.useQuery();
  const setAccess = trpc.info.setAccess.useMutation({
    onSuccess: () => utils.info.get.invalidate(),
    onError: e => toast.error(e.message),
  });
  const [ts, setTs] = useState<TailscaleInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const port = loopbackPort();
  const native = isNative();

  const refresh = () => void tailscaleInfo().then(t => setTs(t ?? null));
  useEffect(refresh, []);

  const tailnet = info.data?.tailnetHosts ?? [];
  const custom = info.data?.customHosts ?? [];
  // Each server is published on its own port (https://<name>:<port>), so the
  // dev server and the container never take each other's address.
  const publicUrl = ts?.dnsName && port ? `https://${ts.dnsName}:${port}` : null;
  const servedHere = !!port && !!ts?.serves.some(s => s.port === port && s.target === `http://127.0.0.1:${port}`);
  const inUse = !!ts?.dnsName && tailnet.includes(ts.dnsName) && servedHere;
  const published = (ts?.serves ?? []).map(s => `:${s.port} → ${s.target}`).join(", ");

  const enableTailscale = async () => {
    if (!ts?.dnsName || !port) return;
    setBusy(true);
    setProblem(null);
    try {
      await tailscaleServe(port);
      await setAccess.mutateAsync({ tailscaleHost: ts.dnsName, tailscalePort: port });
      toast.success(t("settings.access.reachable", { url: `https://${ts.dnsName}:${port}` }));
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const link = problem?.match(/https:\/\/\S+/)?.[0]?.replace(/[.,]$/, "");

  return (
    <SettingsGroup
      id="devices-access"
      title={t("settings.access.title")}
      description={t("settings.access.description")}
      keywords={t("settings.access.keywords")}
    >
      <SettingsRow
        label="Tailscale"
        hint={
          !native
            ? tailnet.length
              ? t("settings.access.inUse", { value: tailnet.join(", ") })
              : t("settings.access.desktopOnly")
            : !ts
              ? t("settings.access.checking")
              : !ts.installed
                ? t("settings.access.notInstalled")
                : !ts.running
                  ? t("settings.access.notRunning")
                  : inUse
                    ? t("settings.access.inUse", { value: publicUrl ?? `https://${ts.dnsName}` })
                    : `${ts.dnsName} · ${published ? t("settings.access.publishes", { target: published }) : t("settings.access.notPublished")}`
        }
      >
        {native && ts && !ts.installed && (
          <Button variant="outline" size="sm" onClick={() => openExternal("https://tailscale.com/download/mac")}>
            {t("settings.access.download")}
          </Button>
        )}
        {native && ts?.running && !inUse && (
          <Button size="sm" disabled={busy || !port} onClick={() => void enableTailscale()}>
            {busy ? t("settings.access.enabling") : t("settings.access.use")}
          </Button>
        )}
        {inUse && <Check className="h-4 w-4 text-success" aria-label={t("settings.access.inUseLabel")} />}
        {native && (
          <Button variant="ghost" size="icon-sm" aria-label={t("settings.access.recheckLabel")} title={t("settings.access.recheck")} onClick={refresh}>
            <RefreshCw />
          </Button>
        )}
      </SettingsRow>
      {native && ts?.running && !port && !inUse && (
        <p className="-mt-1 mb-2 text-caption text-muted-foreground">
          {t("settings.access.needsLocal")}
        </p>
      )}
      {problem && (
        <p className="mb-3 rounded-lg bg-warning-soft p-3 text-body-sm">
          {problem}{" "}
          {link && (
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => openExternal(link)}>
              {t("settings.access.openLink")}
            </button>
          )}
        </p>
      )}

      <div className="border-t pt-3">
        <p className="font-medium">{t("settings.access.namesTitle")}</p>
        <p className="text-caption text-muted-foreground">
          {t("settings.access.namesHint")}
        </p>
        <form
          className="mt-2 flex max-w-md gap-2"
          onSubmit={e => {
            e.preventDefault();
            const name = draft.trim().toLowerCase();
            if (!name) return;
            void setAccess.mutateAsync({ customHosts: [...custom, name] }).then(() => setDraft(""), () => undefined);
          }}
        >
          <Input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={t("settings.access.namePlaceholder")}
            aria-label={t("settings.access.nameLabel")}
            spellCheck={false}
            autoComplete="off"
          />
          <Button type="submit" variant="outline" disabled={!draft.trim()}>
            <Plus />
            {t("common.add")}
          </Button>
        </form>
        {custom.length > 0 && (
          <ul className="mt-2 divide-y">
            {custom.map(h => (
              <li key={h} className="flex items-center gap-3 py-1.5">
                <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
                <span className="flex-1 truncate font-medium">{h}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("settings.access.removeName", { name: h })}
                  onClick={() => setAccess.mutate({ customHosts: custom.filter(x => x !== h) })}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsGroup>
  );
}
