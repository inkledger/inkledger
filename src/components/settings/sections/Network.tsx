import { trpc } from "@/lib/trpc";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/app/States";
import { errorText, toastError } from "@/lib/errorText";
import { dayAndTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../api/router";
import { t } from "@/i18n";
import { useState } from "react";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
import { ListRow } from "@/components/app/ListRow";
import { CopyButton } from "@/components/app/CopyButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { surface } from "@/components/app/surface";
import { alertMessage } from "@/components/notifications/alerts";

type Format = "slack" | "teams" | "json";
const FORMATS: Format[] = ["slack", "teams", "json"];
const formatText = (f: Format) => t(`settings.network.webhookFormats.${f}`);

/** Alerts firing now (for every account), and the webhook they also go to. */
function AlertsGroup() {
  const summary = trpc.alerts.summary.useQuery(undefined, { refetchInterval: 60_000 });
  return (
    <SettingsGroup
      id="network-alerts"
      title={t("settings.network.alertsTitle")}
      description={t("settings.network.alertsText", { cooldown: summary.data?.cooldownMin ?? 360 })}
      keywords={t("settings.network.alertsKeywords")}
    >
      {summary.isPending ? (
        <Skeleton className="h-16" />
      ) : summary.error ? (
        <ErrorState message={errorText(summary.error)} onRetry={() => void summary.refetch()} />
      ) : summary.data.alerts.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t("settings.network.alertsNone")}</p>
      ) : (
        <ul className="divide-y">
          {summary.data.alerts.map(a => (
            <li key={a.key}>
              <ListRow
                lead={<TriangleAlert className="h-4 w-4 text-danger" aria-hidden />}
                title={<span className="[overflow-wrap:anywhere]">{alertMessage({ alert: a.kind, name: a.name, count: a.count })}</span>}
                meta={t("settings.network.alertSince", { when: dayAndTime(new Date(a.since)) })}
              />
            </li>
          ))}
        </ul>
      )}
      <WebhookForm />
    </SettingsGroup>
  );
}

function WebhookForm() {
  const utils = trpc.useUtils();
  const hook = trpc.alerts.webhook.useQuery();
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<Format | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const save = trpc.alerts.setWebhook.useMutation({
    onSuccess: (r, input) => {
      setSecret(r.secret);
      setUrl("");
      toast.success(input ? t("settings.network.webhookSaved") : t("settings.network.webhookRemoved"));
      void utils.alerts.webhook.invalidate();
    },
    onError: e => toastError(e),
  });
  const test = trpc.alerts.test.useMutation({
    onSuccess: () => toast.success(t("settings.network.webhookTested")),
    onError: e => toastError(e),
  });
  const current = hook.data ?? null;
  const shownFormat = format ?? current?.format ?? "slack";
  return (
    <div className="mt-4 grid gap-3 border-t pt-4">
      <div>
        <h3 className="text-body-sm font-medium">{t("settings.network.webhookTitle")}</h3>
        <p className="text-caption text-muted-foreground">{t("settings.network.webhookText")}</p>
      </div>
      <p className="text-body-sm [overflow-wrap:anywhere]">
        {current ? t("settings.network.webhookCurrent", { host: current.host, format: formatText(current.format) }) : t("settings.network.webhookNone")}
      </p>
      <SettingsRow label={t("settings.network.webhookUrl")} htmlFor="alerts-webhook-url">
        <Input id="alerts-webhook-url" type="url" inputMode="url" autoComplete="off" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://" />
      </SettingsRow>
      <SettingsRow label={t("settings.network.webhookFormat")}>
        <Select value={shownFormat} onValueChange={v => setFormat(v as Format)}>
          <SelectTrigger className="w-56" aria-label={t("settings.network.webhookFormat")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORMATS.map(f => (
              <SelectItem key={f} value={f}>
                {formatText(f)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={save.isPending || url.trim() === ""} onClick={() => save.mutate({ url: url.trim(), format: shownFormat })}>
          {t("settings.network.webhookSave")}
        </Button>
        {current && (
          <>
            <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
              {t("settings.network.webhookTest")}
            </Button>
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>
              {t("settings.network.webhookRemove")}
            </Button>
          </>
        )}
      </div>
      {secret && (
        <div role="status" className="grid gap-2 rounded-lg border bg-muted p-3" {...surface("card")}>
          <p className="text-caption text-muted-foreground">{t("settings.network.webhookSecret")}</p>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 text-body-sm [overflow-wrap:anywhere]">{secret}</code>
            <CopyButton text={secret} />
          </div>
        </div>
      )}
    </div>
  );
}

type Row = inferRouterOutputs<AppRouter>["egress"]["list"][number];

const purposeText = (p: Row["purpose"]): string =>
  p.kind === "tracker" ? t("settings.network.purpose.tracker", { name: p.name }) : t(`settings.network.purpose.${p.kind}`);

/** Settings → Network: every host the server has called out to, and what the browser may reach. */
export function NetworkSection() {
  const list = trpc.egress.list.useQuery(undefined, { refetchInterval: 30_000 });
  return (
    <>
      <SettingsGroup id="network-server" title={t("settings.network.serverTitle")} description={t("settings.network.serverText")} keywords={t("settings.network.keywords")}>
        {list.isPending ? (
          <Skeleton className="h-32" />
        ) : list.error ? (
          <ErrorState message={errorText(list.error)} onRetry={() => void list.refetch()} />
        ) : list.data.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">{t("settings.network.none")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-body-sm">
              <thead className="text-caption text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">{t("settings.network.host")}</th>
                  <th className="py-2 pr-3 font-medium">{t("settings.network.purposeTitle")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("settings.network.calls")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("settings.network.failures")}</th>
                  <th className="py-2 font-medium">{t("settings.network.last")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.data.map(r => (
                  <tr key={r.host}>
                    {/* The table scrolls sideways on a phone: a host stays whole ("jira.example.i/t" read badly). */}
                    <td className="whitespace-nowrap py-2 pr-3 font-medium">{r.host}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{purposeText(r.purpose)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.calls}</td>
                    <td className={cn("py-2 pr-3 text-right tabular-nums", r.failures > 0 ? "text-warning" : "text-muted-foreground")}>{r.failures}</td>
                    <td className="py-2 text-muted-foreground">
                      {dayAndTime(r.lastAt)}
                      {r.lastStatus && <span className="ml-1.5 text-caption">({r.lastStatus === "error" ? t("settings.network.noAnswer") : r.lastStatus})</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsGroup>
      <AlertsGroup />
      <SettingsGroup id="network-browser" title={t("settings.network.browserTitle")} description={t("settings.network.browserText")} keywords={t("settings.network.keywords")}>
        <ul className="grid list-disc gap-1 pl-5 text-body-sm">
          <li>{t("settings.network.browserSelf", { host: window.location.host })}</li>
          <li>{t("settings.network.browserOutlook")}</li>
        </ul>
      </SettingsGroup>
    </>
  );
}
