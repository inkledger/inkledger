import { KeyRound, WifiOff } from "lucide-react";
import { Link } from "react-router";
import { SYNC_GIVE_UP_AFTER } from "@contracts/sync";
import { useConnections } from "@/hooks/useConnections";
import { useSync } from "@/hooks/useSync";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/**
 * Slim bar under the header when a connection can't be used as saved (its
 * credentials refused, or no longer readable): the account stays signed in,
 * and one click leads to reconnecting it. A connection out of reach too many
 * times in a row has its background sync paused: one click tries it again.
 */
export function ReconnectBanner() {
  const broken = (useConnections().data ?? []).filter(c => c.status !== "ok");
  const sync = useSync();
  if (broken.length === 0) return null;
  const c = broken[0];
  const unreachable = c.status === "unreachable";
  const Icon = unreachable ? WifiOff : KeyRound;
  return (
    <div className="border-b bg-warning-soft" role="status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-2 text-body-sm md:px-6">
        <Icon className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        <span className="text-foreground">
          {unreachable
            ? t("ui.reconnect.unreachable", { provider: c.name, host: c.host, count: SYNC_GIVE_UP_AFTER })
            : c.status === "unreadable"
              ? t("ui.reconnect.unreadable", { provider: c.name, host: c.host })
              : t("ui.reconnect.refused", { provider: c.name, host: c.host })}
        </span>
        {unreachable ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-warning hover:bg-warning/10"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {t("ui.reconnect.retry")}
          </Button>
        ) : (
          <Button asChild size="sm" variant="ghost" className="h-7 px-2.5 text-warning hover:bg-warning/10">
            <Link to={`/settings/connections?reconnect=${c.id}`}>{t("ui.reconnect.action")}</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
