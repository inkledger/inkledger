import { trpc } from "@/lib/trpc";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/app/States";
import { errorText } from "@/lib/errorText";
import { dayAndTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../api/router";
import { t } from "@/i18n";

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
                    <td className="py-2 pr-3 font-medium [overflow-wrap:anywhere]">{r.host}</td>
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
      <SettingsGroup id="network-browser" title={t("settings.network.browserTitle")} description={t("settings.network.browserText")} keywords={t("settings.network.keywords")}>
        <ul className="grid list-disc gap-1 pl-5 text-body-sm">
          <li>{t("settings.network.browserSelf", { host: window.location.host })}</li>
          <li>{t("settings.network.browserOutlook")}</li>
        </ul>
      </SettingsGroup>
    </>
  );
}
