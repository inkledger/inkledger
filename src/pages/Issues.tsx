import { readStoredJson, writeStored } from "@/lib/storage";
import { toastError, errorText } from "@/lib/errorText";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useToday } from "@/hooks/useToday";
import { keepPreviousData } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useIssueActions } from "@/hooks/useIssueActions";
import { useStartTimer } from "@/hooks/useStartTimer";
import { useListKeyboard } from "@/hooks/useListKeyboard";
import { useUnreadCount } from "@/hooks/useUnreadCount";
import { BrushCleaning, ChevronLeft, ChevronRight, Globe, Plus } from "lucide-react";
import { createIssueDialog } from "@/lib/flag";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { LogTimeDialog } from "@/components/LogTimeDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { daysUntil } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { PageHeader, SectionLabel } from "@/components/app/PageHeader";
import { PanelRow, PanelSection } from "@/components/app/Panel";
import { QuickStatsCard } from "@/components/dashboard/QuickStatsCard";
import { EmptyState, ErrorState } from "@/components/app/States";
import {
  IssueFilters,
  type IssueFilterState,
  type SortMode,
} from "@/components/issues/IssueFilters";
import { IssueCard, IssueRow, IssueTable } from "@/components/issues/IssueRow";
import { usePinnedOrder } from "@/hooks/usePinnedOrder";
import { visibleIssues, issuePath, issueId } from "@/lib/issues";
import { TrackerSearchPanel } from "@/components/issues/TrackerSearchPanel";
import { useUrlFields } from "@/hooks/useUrlState";
import { bool, flag, int, oneOf, text, type Fields } from "@/lib/urlCodecs";
import { toast } from "sonner";
import { parseQuery } from "@contracts/query";
import { useProviderName } from "@/hooks/useConnections";
import { numberFormat, t } from "@/i18n";
import { isClosed, isWaiting } from "@contracts/categories";
import { BucketChip } from "@/components/BucketChip";

const PAGE_SIZE = 25;

const INITIAL_FILTERS: IssueFilterState = {
  search: "",
  status: "all",
  project: "all",
  label: "all",
  sort: "activity",
  favOnly: false,
  includeDone: false,
  includeUnassigned: false,
  hiddenView: false,
  unreadOnly: false,
  watchingOnly: false,
};

/** View preferences survive reloads (search and facets do not). */
const PREFS_KEY = "ikl-issue-filters";
type Prefs = Pick<
  IssueFilterState,
  "sort" | "includeDone" | "includeUnassigned"
>;

function loadFilters(): IssueFilterState {
  const p = readStoredJson(PREFS_KEY);
  if (typeof p !== "object" || p === null) return INITIAL_FILTERS;
  const prefs = p as Partial<Prefs>;
  return {
    ...INITIAL_FILTERS,
    sort: prefs.sort ?? INITIAL_FILTERS.sort,
    includeDone: prefs.includeDone === true,
    includeUnassigned: prefs.includeUnassigned === true,
  };
}

function saveFilters(f: IssueFilterState) {
  const prefs: Prefs = {
    sort: f.sort,
    includeDone: f.includeDone,
    includeUnassigned: f.includeUnassigned,
  };
  // Storage unavailable: preferences last for the session only.
  writeStored(PREFS_KEY, JSON.stringify(prefs));
}

const SORTS = ["activity", "updated", "priority", "key", "due"] as const satisfies readonly SortMode[];

/** Where each filter lives in the URL (fallbacks: the saved preferences). */
function issueFields(prefs: IssueFilterState): Fields<IssueFilterState & { page: number }> {
  return {
    search: { key: "q", fallback: "", codec: text },
    status: { key: "status", fallback: "all", codec: text },
    project: { key: "project", fallback: "all", codec: text },
    label: { key: "label", fallback: "all", codec: text },
    sort: { key: "sort", fallback: prefs.sort, codec: oneOf(SORTS) },
    favOnly: { key: "favorites", fallback: false, codec: flag },
    includeDone: { key: "done", fallback: prefs.includeDone, codec: bool },
    includeUnassigned: { key: "unassigned", fallback: prefs.includeUnassigned, codec: bool },
    hiddenView: { key: "hidden", fallback: false, codec: flag },
    unreadOnly: { key: "unread", fallback: false, codec: flag },
    watchingOnly: { key: "watching", fallback: false, codec: flag },
    page: { key: "p", fallback: 1, codec: int },
  };
}

const PINNED_INPUT = {
  favoriteOnly: true,
  includeDone: true,
  includeUnassigned: true,
  pageSize: 200,
} as const;

export default function Issues() {
  const provider = useProviderName();
  const utils = trpc.useUtils();
  // Filters and page live in the URL: Back from an issue finds them as
  // they were. The view preferences (sort, done, unassigned) also default
  // from the last choice; "/issues?favorites" is the sidebar's "All".
  const fields = useMemo(() => issueFields(loadFilters()), []);
  const [url, setUrl] = useUrlFields(fields);
  const { page, ...filters } = url;
  // A new search, filter or page: its list from the top (these replace the URL entry, which
  // keeps the scroll as it was: right for what is typed elsewhere, not for new results here).
  const toTop = () => {
    document.getElementById("main")?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  };
  const setPage = (p: number) => {
    setUrl({ page: p });
    toTop();
  };

  const [trackerSearchOpen, setTrackerSearchOpen] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [logging, setLogging] = useState<{ key: string; connectionId?: number } | null>(null);

  // Any filter change restarts from page 1.
  const updateFilters = (patch: Partial<IssueFilterState>) => {
    saveFilters({ ...filters, ...patch });
    setUrl({ ...patch, page: 1 });
    toTop();
  };

  const search = useDebouncedValue(filters.search.trim(), 300);
  const used = trpc.queries.used.useMutation({ onSuccess: () => void utils.queries.list.invalidate() });
  /** Enter: kept among the recent searches; a pasted key or link of one issue opens it. */
  const submitSearch = async (q: string) => {
    used.mutate({ query: q });
    if (parseQuery(q).expr?.kind !== "ref") return;
    const named = await utils.issues.open.fetch({ text: q }).catch(() => []);
    if (named.length === 1) void navigate(issuePath({ key: named[0].key, connectionId: named[0].connectionId, remoteId: named[0].remoteId }));
  };

  // Favorites live in their own pinned group, except while searching or
  // browsing the hidden issues.
  const pinnedMode =
    !filters.hiddenView &&
    !search &&
    !filters.unreadOnly &&
    !filters.watchingOnly;
  const showMain = !(pinnedMode && filters.favOnly);

  const listInput = useCallback(
    (p: number) => ({
      search: search || undefined,
      status: filters.status === "all" ? undefined : filters.status,
      projectKey: filters.project === "all" ? undefined : filters.project,
      label: filters.label === "all" ? undefined : filters.label,
      favoriteOnly: (!pinnedMode && filters.favOnly) || undefined,
      unreadOnly: filters.unreadOnly || undefined,
      watchingOnly: (!filters.hiddenView && filters.watchingOnly) || undefined,
      includeDone: filters.includeDone,
      includeUnassigned: filters.includeUnassigned,
      hidden: filters.hiddenView ? ("only" as const) : ("exclude" as const),
      excludeFavorites: pinnedMode,
      sort: filters.sort,
      page: p,
      pageSize: PAGE_SIZE,
    }),
    [search, filters, pinnedMode]
  );

  const query = trpc.issues.list.useQuery(listInput(page), {
    placeholderData: keepPreviousData,
  });
  const pinnedQuery = trpc.issues.list.useQuery(
    {
      ...PINNED_INPUT,
      sort: filters.sort,
      status: filters.status === "all" ? undefined : filters.status,
      projectKey: filters.project === "all" ? undefined : filters.project,
      label: filters.label === "all" ? undefined : filters.label,
    },
    { enabled: pinnedMode }
  );
  const pinned = usePinnedOrder(pinnedQuery.data?.issues ?? []);
  const data = query.data;

  // Past the last page (the last issue on it was hidden, or a link to an old
  // page): back to the last one, or the list is empty with no way back.
  const lastPage = data && !query.isPlaceholderData ? Math.max(1, data.totalPages) : null;
  useEffect(() => {
    if (lastPage !== null && page > lastPage) setUrl({ page: lastPage });
  }, [lastPage, page, setUrl]);

  // Prefetch next page for instant navigation.
  const totalPages = data?.totalPages ?? 0;
  useEffect(() => {
    if (page < totalPages) {
      void utils.issues.list.prefetch(listInput(page + 1));
    }
  }, [page, totalPages, listInput, utils]);

  const cleanup = trpc.issues.cleanup.useMutation({
    onSuccess: r => {
      toast.success(
        t("pages.issues.cleanupDone", { deleted: r.deleted, kept: r.kept })
      );
      void utils.issues.invalidate();
    },
    onError: e => toastError(e),
  });

  const all = trpc.issues.all.useQuery();
  const today = useToday();
  const summary = useMemo(() => {
    const rows = visibleIssues(all.data ?? []);
    const open = rows.filter(i => !isClosed(i.category));
    return {
      total: rows.length,
      inProgress: rows.filter(i => i.category === "doing").length,
      todo: rows.filter(i => isWaiting(i.category)).length,
      done: rows.length - open.length,
      overdue: open.filter(i => {
        const d = i.dueDate ? daysUntil(i.dueDate.slice(0, 10), today) : null;
        return d !== null && d < 0;
      }).length,
      favorites: rows.filter(i => i.favorite === 1).length,
    };
  }, [all.data, today]);

  const openLog = useCallback((key: string, connectionId?: number) => setLogging({ key, connectionId }), [setLogging]);
  const unreadCount = useUnreadCount();
  const issues = useMemo(() => data?.issues ?? [], [data]);

  // j / k over everything on screen: pinned favorites first, then the list.
  const navigate = useNavigate();
  const act = useIssueActions();
  const start = useStartTimer({ announce: true });
  const onScreen = useMemo(
    () => [
      ...(pinnedMode && page === 1 ? pinned.ordered : []),
      ...(showMain ? issues : []),
    ],
    [pinnedMode, page, pinned.ordered, showMain, issues]
  );
  // Rows by identity: two trackers' APP-1 are two rows.
  const byId = (id: string) => onScreen.find(i => issueId(i) === id);
  const onRow = (id: string, run: (i: (typeof onScreen)[number]) => void) => {
    const i = byId(id);
    if (i) run(i);
  };
  const { selected } = useListKeyboard(
    onScreen.map(i => issueId(i)),
    {
      open: id => onRow(id, i => void navigate(issuePath(i))),
      s: id => onRow(id, i => void act.toggleFavorite(i.key, i.connectionId)),
      h: id => onRow(id, i => void (i.hidden === 1 ? act.restore(i.key, i.connectionId) : act.hide(i.key, i.connectionId))),
      t: id => onRow(id, i => start.mutate({ issueKey: i.key, connectionId: i.connectionId })),
      c: id => onRow(id, i => void act.copyKey(i.key)),
      b: id => onRow(id, i => void act.copyBranch(i.key, i.summary)),
    }
  );

  return (
    <>
      <PageHeader
        sticky
        title={t("pages.issues.title")}
        description={
          data
            ? t("pages.issues.inView", {
                shown: numberFormat().format(
                  data.total + (pinnedMode ? pinned.ordered.length : 0)
                ),
                total: numberFormat().format(summary.total),
              })
            : undefined
        }
        actions={
          <>
            <Button onClick={() => createIssueDialog.set(true)}>
              <Plus className="h-4 w-4" />
              {t("pages.issues.new")}
            </Button>
            <Button
              variant="outline"
              className={cn(
                trackerSearchOpen &&
                  "border-primary-strong/40 bg-primary-soft text-primary-strong"
              )}
              aria-pressed={trackerSearchOpen}
              onClick={() => setTrackerSearchOpen(v => !v)}
            >
              <Globe className="h-4 w-4" />
              {t("pages.issues.trackerSearch", { provider })}
            </Button>
            <Button
              variant="outline"
              onClick={() => setConfirmCleanup(true)}
              disabled={cleanup.isPending}
            >
              <BrushCleaning className="h-4 w-4" />
              {t("pages.issues.cleanup")}
            </Button>
          </>
        }
      />

      {trackerSearchOpen && <TrackerSearchPanel initialQuery={filters.search.trim()} />}

      <PanelRow className="xl:grid-cols-[minmax(0,1fr)_340px]">
        <PanelSection
          title={t("pages.issues.catalog")}
          className="border-b xl:border-b-0 xl:border-r"
        >
          <BucketChip />
          <IssueFilters
            filters={filters}
            onChange={updateFilters}
            statuses={data?.statuses ?? []}
            projects={data?.projects ?? []}
            labels={data?.labels ?? []}
            counts={data?.counts}
            unread={unreadCount}
            onSearchSubmit={q => void submitSearch(q)}
          />
          {data && (data.query.unsupported.length > 0 || data.query.warnings.length > 0) && (
            <p className="-mt-2 mb-3 text-caption text-muted-foreground" role="status">
              {data.query.unsupported.length > 0 && t("views.issues.filters.queryUnsupported", { terms: data.query.unsupported.join(" ") })}
              {data.query.unsupported.length > 0 && data.query.warnings.length > 0 && " · "}
              {data.query.warnings.length > 0 && t("views.issues.filters.queryUnread", { terms: data.query.warnings.map(w => w.at).join(" ") })}
            </p>
          )}

          {pinnedMode && page === 1 && pinned.ordered.length > 0 && (
            <section aria-labelledby="pinned-title" className="mb-6">
              <SectionLabel
                as="h3"
                id="pinned-title"
                className="mb-1 flex items-center gap-2 px-0"
              >
                {t("pages.issues.favorites")}
                <span className="normal-case tracking-normal">
                  <span className="max-md:hidden">
                    {t("pages.issues.dragToReorder")}
                  </span>
                  <span className="md:hidden">{t("pages.issues.reorderFromMenu")}</span>
                </span>
              </SectionLabel>
              <IssueTable>
                {pinned.ordered.map((i, idx) => (
                  <IssueRow
                    key={issueId(i)}
                    issue={i}
                    onLog={openLog}
                    pin={pinned.pinFor(issueId(i), idx)}
                    selected={selected === issueId(i)}
                  />
                ))}
              </IssueTable>
              <ul className="divide-y border-t md:hidden">
                {pinned.ordered.map((i, idx) => (
                  <IssueCard
                    key={issueId(i)}
                    issue={i}
                    onLog={openLog}
                    pin={pinned.pinFor(issueId(i), idx)}
                  />
                ))}
              </ul>
            </section>
          )}

          {showMain &&
            pinnedMode &&
            page === 1 &&
            pinned.ordered.length > 0 && (
              <SectionLabel as="h3" className="mb-1 px-0">
                {filters.includeDone || filters.includeUnassigned
                  ? t("pages.issues.allOthers")
                  : t("pages.issues.openAssigned")}
              </SectionLabel>
            )}

          {showMain && query.error && data && (
            // The rows below are from before: said, never shown as current.
            <p role="alert" className="mb-2 flex flex-wrap items-center gap-2 text-body-sm text-danger">
              {t("pages.issues.staleError", { reason: errorText(query.error) })}
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t("common.retry")}
              </Button>
            </p>
          )}

          {showMain && (
            <div aria-busy={query.isFetching}>
              {query.isPending ? (
                <div className="grid gap-2 py-3">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : query.error && !data ? (
                <ErrorState
                  message={errorText(query.error)}
                  onRetry={() => query.refetch()}
                />
              ) : issues.length === 0 ? (
                <EmptyState
                  art="search"
                  title={t("pages.issues.noIssues")}
                  message={
                    data &&
                    data.total === 0 &&
                    !search &&
                    filters.status === "all" &&
                    filters.project === "all" &&
                    filters.label === "all"
                      ? t("pages.issues.emptyCatalog", { provider })
                      : t("pages.issues.emptyFiltered", { provider })
                  }
                />
              ) : (
                <>
                  <IssueTable
                    sort={filters.sort}
                    onSort={sort => updateFilters({ sort })}
                  >
                    {issues.map(i => (
                      <IssueRow
                        key={issueId(i)}
                        issue={i}
                        onLog={openLog}
                        selected={selected === issueId(i)}
                      />
                    ))}
                  </IssueTable>
                  <ul className="divide-y border-t md:hidden">
                    {issues.map(i => (
                      <IssueCard key={issueId(i)} issue={i} onLog={openLog} />
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {showMain && data && data.totalPages > 1 && (
            <nav
              aria-label={t("pages.issues.pagination")}
              className="mt-2 flex items-center justify-between gap-2 border-t pt-4 text-body-sm"
            >
              <span className="text-muted-foreground">
                {t("pages.issues.pageOf", { page: data.page, total: data.totalPages })}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  {t("pages.issues.previous")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= data.totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  {t("pages.issues.next")}
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </nav>
          )}
        </PanelSection>

        <aside
          aria-label={t("pages.issues.summary")}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6 p-5 md:p-6"
        >
          {all.isPending ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : all.error ? (
            <ErrorState
              message={errorText(all.error)}
              onRetry={() => all.refetch()}
            />
          ) : (
            <>
              <QuickStatsCard
                title={t("pages.issues.catalog")}
                stats={[
                  { label: t("pages.issues.inProgress"), value: String(summary.inProgress) },
                  {
                    label: t("pages.issues.overdue"),
                    value: String(summary.overdue),
                    tone: summary.overdue > 0 ? "danger" : undefined,
                  },
                ]}
                extra={[
                  { label: t("pages.issues.total"), value: String(summary.total) },
                  {
                    label: t("pages.issues.favorites"),
                    value: String(summary.favorites),
                  },
                  { label: t("pages.issues.todo"), value: String(summary.todo) },
                  { label: t("pages.issues.done"), value: String(summary.done) },
                ]}
              />
            </>
          )}
        </aside>
      </PanelRow>

      {logging && (
        <LogTimeDialog
          key={`${logging.connectionId ?? ""}:${logging.key}`}
          issueKey={logging.key}
          connectionId={logging.connectionId}
          open
          onOpenChange={o => {
            if (!o) setLogging(null);
          }}
        />
      )}

      <AlertDialog open={confirmCleanup} onOpenChange={setConfirmCleanup}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.issues.cleanupTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.issues.cleanupText", { provider })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("pages.issues.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => cleanup.mutate()}>
              {t("pages.issues.cleanup")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
