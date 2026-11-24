import { Link } from "react-router";
import { TriangleAlert, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { alertAgo, alertMessage, alertPath, useAlerts } from "@/components/notifications/alerts";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/app/PageHeader";
import { surface } from "@/components/app/surface";

/** Alerts above the notifications: opening one leads to where it is fixed, and archives it. */
export function AlertList({ onOpen }: { onOpen?: () => void }) {
  const alerts = useAlerts();
  const utils = trpc.useUtils();
  const dismiss = trpc.notifications.dismiss.useMutation({
    onSettled: () => void utils.notifications.alerts.invalidate(),
  });
  const rows = alerts.data ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="grid gap-2" aria-label={t("settings.notifications.alertsTitle")}>
      <SectionLabel>{t("settings.notifications.alertsTitle")}</SectionLabel>
      <ul className="grid gap-2">
        {rows.map((a) => (
          <li key={a.id} {...surface("card")} className="flex min-w-0 items-center gap-3 rounded-lg border bg-card p-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger" aria-hidden {...surface("picture")}>
              <TriangleAlert className="h-4 w-4" />
            </span>
            <Link
              to={alertPath(a)}
              aria-label={t("settings.notifications.alertOpen")}
              onClick={() => {
                dismiss.mutate({ id: a.id });
                onOpen?.();
              }}
              className="min-w-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="block text-body-sm [overflow-wrap:anywhere]">{alertMessage(a)}</span>
              <span className="mt-0.5 block truncate text-caption text-muted-foreground">{alertAgo(a.createdAt)}</span>
            </Link>
            <Button variant="ghost" size="icon-sm" aria-label={t("settings.notifications.alertArchive")} title={t("settings.notifications.archive")} onClick={() => dismiss.mutate({ id: a.id })}>
              <X className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
