import { RotateCcw } from "lucide-react";
import { SettingsDisclosure, SettingsGroup } from "@/components/settings/SettingsGroup";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { ErrorState, PageSpinner } from "@/components/app/States";
import { toastError } from "@/lib/errorText";
import { STATUS_CATEGORIES, type StatusCategory } from "@contracts/providers";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

const CATEGORY: Record<StatusCategory, () => string> = {
  triage: () => t("pages.board.categories.triage"),
  backlog: () => t("pages.board.categories.backlog"),
  todo: () => t("pages.board.categories.todo"),
  doing: () => t("pages.board.categories.doing"),
  done: () => t("pages.board.categories.done"),
  cancelled: () => t("pages.board.categories.cancelled"),
};

/**
 * Which statuses of each tracker count as work for estimates (docs/work/ideas/estimates.md R-3.14),
 * and how many closed issues have their history read. One group: per tracker a caption and its
 * statuses as a dense grid by category (one switch each; only a changed one offers its default back).
 */
export function EstimatesSection() {
  const list = trpc.connections.list.useQuery();
  if (list.isLoading) return <PageSpinner />;
  if (list.isError) return <ErrorState onRetry={() => void list.refetch()} />;
  const trackers = (list.data ?? []).filter(c => c.role !== "timeSink");
  return (
    <SettingsGroup id="estimates" title={t("settings.estimates.title")} description={t("settings.estimates.description")}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        {trackers.map(c => (
          <ConnectionStatuses key={c.id} connectionId={c.id} name={c.label || c.name} named={trackers.length > 1} />
        ))}
      </div>
      <HistoryStates />
    </SettingsGroup>
  );
}

function HistoryStates() {
  const states = trpc.estimates.historyStates.useQuery();
  const s = states.data;
  return (
    <SettingsDisclosure
      id="estimates-history"
      title={s ? `${t("settings.estimates.historyTitle")} · ${s.available}` : t("settings.estimates.historyTitle")}
      keywords={t("settings.estimates.historyKeywords")}
    >
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
    </SettingsDisclosure>
  );
}

function ConnectionStatuses({ connectionId, name, named }: { connectionId: number; name: string; named: boolean }) {
  const utils = trpc.useUtils();
  const statuses = trpc.estimates.workStatuses.useQuery({ connectionId }, { retry: false });
  const set = trpc.estimates.setWorkStatus.useMutation({
    onSettled: () => {
      void utils.estimates.workStatuses.invalidate({ connectionId });
      void utils.estimates.forIssue.invalidate();
    },
    onError: e => toastError(e),
  });
  const rows = statuses.data ?? [];
  const changed = rows.filter(s => !s.byDefault);
  // By category, as a board reads: from triage to cancelled.
  const groups = STATUS_CATEGORIES.map(category => ({ category, rows: rows.filter(s => s.category === category) })).filter(g => g.rows.length > 0);
  const resetAll = async () => {
    for (const s of changed) await set.mutateAsync({ connectionId, statusId: s.statusId, counts: null }).catch(() => {});
  };
  return (
    <section aria-label={t("settings.estimates.forTracker", { name })} className="grid min-w-0 gap-2">
      {(named || changed.length > 1) && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {named && <h3 className="min-w-0 truncate text-caption font-medium text-muted-foreground">{name}</h3>}
          {changed.length > 1 && (
            <Button variant="link" size="sm" className="h-auto p-0" disabled={set.isPending} onClick={() => void resetAll()}>
              {t("settings.estimates.resetAll", { count: changed.length })}
            </Button>
          )}
        </div>
      )}
      {statuses.isError ? (
        <ErrorState onRetry={() => void statuses.refetch()} />
      ) : statuses.isLoading ? (
        <PageSpinner />
      ) : rows.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t("settings.estimates.noStatuses")}</p>
      ) : (
        groups.map(g => (
          <div key={g.category} className="grid min-w-0 gap-1">
            <p className="text-caption text-muted-foreground">{CATEGORY[g.category]()}</p>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(11rem,100%),1fr))] gap-x-4 gap-y-0.5">
              {g.rows.map(s => (
                <li key={s.statusId} className="flex min-h-9 min-w-0 items-center gap-2 coarse:min-h-touch">
                  <Switch
                    aria-label={`${t("settings.estimates.counts")}: ${s.name}`}
                    checked={s.counts}
                    disabled={set.isPending}
                    onCheckedChange={v => set.mutate({ connectionId, statusId: s.statusId, counts: v })}
                  />
                  <span className="min-w-0 flex-1 text-body-sm [overflow-wrap:anywhere]">{s.name}</span>
                  {!s.byDefault && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label={`${t("settings.estimates.reset")}: ${s.name}`}
                      title={t("settings.estimates.reset")}
                      disabled={set.isPending}
                      onClick={() => set.mutate({ connectionId, statusId: s.statusId, counts: null })}
                    >
                      <RotateCcw />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
