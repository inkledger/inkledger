import { toastError, errorText } from "@/lib/errorText";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { useState } from "react";
import { Link } from "react-router";
import { Check, Eye, Plus, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/app/Chip";
import { PanelSection } from "@/components/app/Panel";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { projectOf } from "@/lib/projectColors";
import { ErrorState } from "@/components/app/States";
import { StatusBadge } from "@/components/StatusBadge";
import { toast } from "sonner";
import { useConnections, useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { issuePath } from "@/lib/issues";

type SearchResult = inferRouterOutputs<AppRouter>["issues"]["searchOn"]["results"][number];

/** Search every connected tracker at once (any issue, not only mine): open, import or watch what comes back. */
export function TrackerSearchPanel() {
  const provider = useProviderName();
  // The connection is named on each result only when there is more than one.
  const several = (useConnections().data ?? []).filter(c => c.role === "tracker").length > 1;
  const utils = trpc.useUtils();
  const [input, setInput] = useState("");
  const query = useDebouncedValue(input.trim(), 300);
  const enabled = query.length >= 2;
  // One question per tracker: each answer shows as it arrives.
  const trackers = (useConnections().data ?? []).filter(c => c.role === "tracker" && c.status === "ok");
  const answers = trpc.useQueries(q => trackers.map(c => q.issues.searchOn({ connectionId: c.id, query }, { enabled, retry: false, staleTime: 60_000 })));
  const search = {
    data: answers.some(a => a.data) ? { results: answers.flatMap(a => a.data?.results ?? []), failed: answers.flatMap(a => (a.data?.failed ? [a.data.failed] : [])) } : undefined,
    isFetching: answers.some(a => a.isFetching),
    error: answers.every(a => a.error) && answers.length > 0 ? answers[0].error : null,
    refetch: () => answers.forEach(a => void a.refetch()),
  };
  const unsupported = [...new Set(answers.flatMap(a => a.data?.unsupported ?? []))];
  const refresh = () =>
    Promise.all([utils.issues.list.invalidate(), utils.issues.all.invalidate(), utils.issues.search.invalidate()]);
  const importIssue = trpc.issues.import.useMutation({
    onSuccess: async r => {
      toast.success(t("views.issues.search.imported", { key: r.imported }));
      await refresh();
    },
    onError: e => toastError(e),
  });
  const watch = trpc.issues.watch.useMutation({
    onSuccess: async r => {
      toast.success(r.watching ? t("views.issues.search.nowWatching", { key: r.key }) : t("views.issues.search.noLongerWatching", { key: r.key }), {
        description: r.watching ? t("views.issues.search.watchingHint") : undefined,
      });
      await refresh();
    },
    onError: e => toastError(e),
  });
  // The key asked for, then titles with every word, then the most recent, then mine.
  const words = query.toLowerCase().split(/\s+/).filter(w => w && !w.includes(":"));
  const rank = (r: SearchResult) =>
    [r.key.toLowerCase() === query.toLowerCase() ? 0 : 1, words.length && words.every(w => r.summary.toLowerCase().includes(w)) ? 0 : 1, -(r.updatedAt ?? 0), r.isMine ? 0 : 1];
  const results = [...(search.data?.results ?? [])].sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const failed = search.data?.failed ?? [];

  return (
    <PanelSection title={t("views.issues.search.title", { provider })} className="border-b">
      <div className="relative mb-4">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input
          autoFocus
          className="pl-8"
          placeholder={t("views.issues.search.placeholder", { provider })}
          aria-label={t("views.issues.search.label", { provider })}
          value={input}
          onChange={e => setInput(e.target.value)}
        />
      </div>
      {!enabled ? (
        <p className="text-body-sm text-muted-foreground">{t("views.issues.search.minChars")}</p>
      ) : search.isFetching && !search.data ? (
        <Skeleton className="h-20" />
      ) : search.error ? (
        <ErrorState
          title={t("views.issues.search.failed", { provider })}
          message={errorText(search.error)}
          onRetry={() => search.refetch()}
          className="py-6"
        />
      ) : (
        <>
          {unsupported.length > 0 && (
            <p role="status" className="pb-2 text-body-sm text-muted-foreground">
              {t("views.issues.search.notApplied", { terms: unsupported.join(" · ") })}
            </p>
          )}
          {failed.map(f => (
            <p key={f.connectionId} role="status" className="pb-2 text-body-sm text-warning">
              {t("views.issues.search.connectionFailed", { connection: f.label, message: f.message })}
            </p>
          ))}
          {results.length === 0 ? (
            <p className="py-3 text-center text-body-sm text-muted-foreground">{t("views.issues.search.noResults", { provider })}</p>
          ) : (
            <ul aria-busy={search.isFetching}>
              {results.map(r => (
                <li
                  key={`${r.connectionId}:${r.remoteId}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t py-3 text-body-sm"
                >
                  {/* Opens the issue live from its tracker: importing is a separate choice. */}
                  <Link
                    to={issuePath({ key: r.key, connectionId: r.connectionId, remoteId: r.remoteId })}
                    title={r.imported ? t("views.issues.search.open") : t("views.issues.search.openWithoutImport")}
                    className="flex min-w-0 flex-1 basis-64 items-center gap-3 underline-offset-4 hover:underline"
                  >
                    <ProjectAvatar project={projectOf(r.key)} connectionId={r.connectionId} />
                    <span className="shrink-0 font-semibold">{r.key}</span>
                    <span className="truncate">{r.summary}</span>
                  </Link>
                  {several && <Chip>{r.connectionLabel}</Chip>}
                  {r.client && <Chip tone="info">{r.client}</Chip>}
                  <StatusBadge status={r.status} category={r.category} />
                  {!r.isMine && (
                    <Chip tone="warning">
                      {r.assignee ? t("views.issues.search.assignedTo", { name: r.assignee }) : t("views.issues.search.unassigned")}
                    </Chip>
                  )}
                  {r.imported ? (
                    <Chip tone="success">
                      <Check className="h-3 w-3" aria-hidden />
                      {t("views.issues.search.inCatalogue")}
                    </Chip>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={t("views.issues.search.importLabel", { key: r.key })}
                      onClick={() => importIssue.mutate({ key: r.key, connectionId: r.connectionId })}
                      disabled={importIssue.isPending}
                    >
                      <Plus className="h-4 w-4" />
                      {t("views.issues.search.import")}
                    </Button>
                  )}
                  {r.canWatch && (
                    <Button
                      size="sm"
                      variant={r.watching ? "secondary" : "ghost"}
                      aria-pressed={r.watching}
                      aria-label={r.watching ? t("views.issues.search.unwatchLabel", { key: r.key }) : t("views.issues.search.watchLabel", { key: r.key })}
                      onClick={() => watch.mutate({ key: r.key, connectionId: r.connectionId, watch: !r.watching })}
                      disabled={watch.isPending}
                    >
                      <Eye className="h-4 w-4" />
                      {r.watching ? t("views.issues.search.watching") : t("views.issues.search.watch")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PanelSection>
  );
}
