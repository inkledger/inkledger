import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/app/Chip";
import { ErrorState, PageSpinner } from "@/components/app/States";
import { toastError } from "@/lib/errorText";
import { STATUS_CATEGORIES } from "@contracts/providers";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

/** Which statuses of each tracker count as work for estimates (docs/work/ideas/estimates.md R-3.14), and how many closed issues have their history read. */
export function EstimatesSection() {
  const list = trpc.connections.list.useQuery();
  if (list.isLoading) return <PageSpinner />;
  if (list.isError) return <ErrorState onRetry={() => void list.refetch()} />;
  const trackers = (list.data ?? []).filter(c => c.role !== "timeSink");
  return (
    <>
      <HistoryStates />
      {trackers.map(c => (
        <ConnectionStatuses key={c.id} connectionId={c.id} name={c.label || c.name} />
      ))}
    </>
  );
}

function HistoryStates() {
  const states = trpc.estimates.historyStates.useQuery();
  const s = states.data;
  return (
    <SettingsGroup id="estimates-history" title={t("settings.estimates.historyTitle")}>
      {states.isError ? (
        <ErrorState onRetry={() => void states.refetch()} />
      ) : !s ? (
        <PageSpinner />
      ) : (
        <ul className="grid gap-1 text-body-sm text-muted-foreground" data-testid="estimates-history">
          <li>{t("settings.estimates.state.available", { count: s.available })}</li>
          <li>{t("settings.estimates.state.waiting", { count: s.pending + s.stale + s.retry })}</li>
          <li>{t("settings.estimates.state.unsupported", { count: s.unsupported })}</li>
          <li>{t("settings.estimates.state.invalid", { count: s.invalid })}</li>
        </ul>
      )}
    </SettingsGroup>
  );
}

function ConnectionStatuses({ connectionId, name }: { connectionId: number; name: string }) {
  const utils = trpc.useUtils();
  const statuses = trpc.estimates.workStatuses.useQuery({ connectionId }, { retry: false });
  const set = trpc.estimates.setWorkStatus.useMutation({
    onSettled: () => {
      void utils.estimates.workStatuses.invalidate({ connectionId });
      void utils.estimates.forIssue.invalidate();
    },
    onError: e => toastError(e),
  });
  // By category, as a board reads: from triage to cancelled.
  const rows = [...(statuses.data ?? [])].sort((a, b) => STATUS_CATEGORIES.indexOf(a.category) - STATUS_CATEGORIES.indexOf(b.category));
  return (
    <SettingsGroup id={`estimates-${connectionId}`} title={t("settings.estimates.title") + " · " + name}>
      {statuses.isError ? (
        <ErrorState onRetry={() => void statuses.refetch()} />
      ) : statuses.isLoading ? (
        <PageSpinner />
      ) : rows.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t("settings.estimates.noStatuses")}</p>
      ) : (
        rows.map(s => (
          <SettingsRow
            key={s.statusId}
            label={<span className="[overflow-wrap:anywhere]">{s.name}</span>}
            hint={
              s.byDefault ? (
                <Chip>{t("settings.estimates.default")}</Chip>
              ) : (
                <Button variant="link" size="sm" className="h-auto p-0" disabled={set.isPending} onClick={() => set.mutate({ connectionId, statusId: s.statusId, counts: null })}>
                  {t("settings.estimates.reset")}
                </Button>
              )
            }
          >
            <Switch
              aria-label={`${t("settings.estimates.counts")}: ${s.name}`}
              checked={s.counts}
              disabled={set.isPending}
              onCheckedChange={v => set.mutate({ connectionId, statusId: s.statusId, counts: v })}
            />
          </SettingsRow>
        ))
      )}
    </SettingsGroup>
  );
}
