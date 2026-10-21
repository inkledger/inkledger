import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../api/router";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  ChevronsLeftRight,
  ChevronsRightLeft,
  Columns3,
  Layers,
  LayoutGrid,
  Pin,
  Plus,
  Rows3,
  Search,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { byRelevance, visibleIssues, issueId } from "@/lib/issues";
import { statusCategoryDotTone } from "@/lib/jira";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/app/PageHeader";
import { PanelSection } from "@/components/app/Panel";
import { Input } from "@/components/ui/input";
import { Dot } from "@/components/app/Chip";
import { EmptyState, ErrorState } from "@/components/app/States";
import { Illustration } from "@/components/app/Illustration";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BoardCard } from "@/components/board/BoardCard";
import { useUrlFields } from "@/hooks/useUrlState";
import { int, text, textSet, type Fields } from "@/lib/urlCodecs";
import { toast } from "sonner";
import { useCollapsedColumns } from "@/hooks/useCollapsedColumns";
import {
  pinboardPanel,
  usePinboardBoardId,
  usePinboardPanel,
} from "@/hooks/usePinboardPanel";
import { Pinboard } from "@/components/board/Pinboard";
import { pinboardSheet } from "@/lib/flag";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useConnections, useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { TransitionDialog, type TransitionTarget } from "@/components/issue/TransitionDialog";
import { CATEGORY_ORDER, categoryRank, isClosed } from "@contracts/categories";
import { BUCKET_SCOPE, useBuckets } from "@/hooks/useBuckets";
import { columnOf, dropTargets, reachable, type BoardColumn, type Way } from "@/lib/boardTargets";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const DONE_LIMIT = 20;

const BOARD_FIELDS: Fields<{ term: string; expanded: Set<string>; connection: number }> = {
  term: { key: "q", fallback: "", codec: text },
  expanded: { key: "expanded", fallback: new Set(), codec: textSet },
  // One tracker only (0: the device's bucket as it is)
  connection: { key: "c", fallback: 0, codec: int },
};

/** What the board works on: the device's bucket (shared with the app's switcher), or one tracker. */
function BoardScope({ connection, onConnection }: { connection: number; onConnection: (id: number) => void }) {
  const { buckets, active, choose } = useBuckets();
  const connections = (useConnections().data ?? []).filter(c => c.role === "tracker");
  const one = connections.find(c => c.id === connection);
  const label = one ? one.label || one.name : (active?.name ?? t("ui.buckets.everything"));
  const value = one ? `c:${one.id}` : active ? `b:${active.id}` : "all";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" aria-label={t("pages.board.scopeLabel", { name: label })}>
          <Layers className="h-4 w-4" />
          <span className="max-w-40 truncate">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={v => {
            if (v.startsWith("c:")) return onConnection(Number(v.slice(2)));
            onConnection(0);
            choose(v === "all" ? null : Number(v.slice(2)));
          }}
        >
          <DropdownMenuRadioItem value="all">{t("ui.buckets.everything")}</DropdownMenuRadioItem>
          {buckets.length > 0 && <DropdownMenuLabel>{t("pages.board.scopeBuckets")}</DropdownMenuLabel>}
          {buckets.map(b => (
            <DropdownMenuRadioItem key={b.id} value={`b:${b.id}`}>
              {b.name}
            </DropdownMenuRadioItem>
          ))}
          {connections.length > 1 && <DropdownMenuLabel>{t("pages.board.scopeTrackers")}</DropdownMenuLabel>}
          {connections.length > 1 &&
            connections.map(c => (
              <DropdownMenuRadioItem key={c.id} value={`c:${c.id}`}>
                {c.label || c.name}
              </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type BoardMode = "lanes" | "category" | "custom";

const categoryTitle = (c: string) =>
  ({
    triage: t("pages.board.categories.triage"),
    backlog: t("pages.board.categories.backlog"),
    todo: t("pages.board.categories.todo"),
    doing: t("pages.board.categories.doing"),
    done: t("pages.board.categories.done"),
    cancelled: t("pages.board.categories.cancelled"),
  })[c] ?? c;
const MODE_KEY = "ikl-board-mode";
const readMode = (): BoardMode => {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "category" ? "category" : "lanes";
  } catch {
    return "lanes";
  }
};

type Row = inferRouterOutputs<AppRouter>["issues"]["all"][number];
type Lane = { connectionId: number | null; label: string; columns: (BoardColumn & { title: string; category: string })[] };
/** The card being dragged, and the ways on its tracker offers (null while they load). */
type Dragging = { card: Row; ways: Way[] | null };

export default function Board() {
  const provider = useProviderName();
  const utils = trpc.useUtils();
  const query = trpc.issues.all.useQuery(BUCKET_SCOPE);
  // A catalogue past what the board holds is said, never cut silently.
  const size = trpc.issues.allSize.useQuery(BUCKET_SCOPE, { staleTime: 60_000 });
  const cut = size.data && size.data.total > size.data.limit ? size.data : null;
  // Search, one tracker and expanded "done" columns live in the URL: Back
  // from an issue finds the board as it was.
  const [view, setView] = useUrlFields(BOARD_FIELDS);
  const term = view.term;
  const setTerm = (v: string) => setView({ term: v });
  const [dragOver, setDragOver] = useState<string | null>(null);
  const showAllDone = view.expanded;
  const setShowAllDone = (f: (s: Set<string>) => Set<string>) => setView({ expanded: f(showAllDone) });

  const { collapsed, toggle: toggleCollapsed } = useCollapsedColumns();
  const panel = usePinboardPanel();
  const mobileBoard = pinboardSheet.useValue();
  const boardId = usePinboardBoardId();
  const pinBoards = trpc.pinboard.boards.useQuery().data ?? [];
  const pinned =
    (pinBoards.find(b => b.id === boardId) ?? pinBoards[0])?.count ?? 0;

  // What the board works on (the device's bucket, or one tracker) and how it lays it out.
  const { active } = useBuckets();
  const connectionsData = useConnections().data;
  const connections = useMemo(() => connectionsData ?? [], [connectionsData]);
  const nameOf = (id: number) => {
    const c = connections.find(x => x.id === id);
    return c ? c.label || c.name : String(id);
  };
  const [localMode, setLocalMode] = useState<BoardMode>(readMode);
  const setBucketMode = trpc.buckets.setBoardMode.useMutation({ onSuccess: () => void utils.buckets.list.invalidate() });
  const customColumns = active?.columns ?? [];
  const mode: BoardMode = active ? (active.boardMode === "custom" && customColumns.length === 0 ? "lanes" : active.boardMode) : localMode;
  const setMode = (m: BoardMode) => {
    if (active) setBucketMode.mutate({ id: active.id, mode: m });
    else {
      setLocalMode(m);
      try {
        localStorage.setItem(MODE_KEY, m);
      } catch {
        // per-device convenience only
      }
    }
  };
  const statuses = trpc.buckets.statuses.useQuery(undefined, { staleTime: 5 * 60_000 }).data ?? [];

  const [asking, setAsking] = useState<{ key: string; connectionId: number; target: TransitionTarget } | null>(null);
  const [choosing, setChoosing] = useState<{ card: Row; statuses: string[] } | null>(null);
  const transition = trpc.issues.transition.useMutation({
    onMutate: async ({ key, connectionId, toStatus }) => {
      await utils.issues.all.cancel();
      const previous = utils.issues.all.getData(BUCKET_SCOPE);
      const category = statuses.find(s => s.connectionId === connectionId && s.status === toStatus)?.category;
      utils.issues.all.setData(BUCKET_SCOPE, old =>
        old?.map(i =>
          i.key === key && i.connectionId === connectionId
            ? {
                ...i,
                status: toStatus ?? i.status,
                category: category ?? i.category,
              }
            : i
        )
      );
      return { previous };
    },
    onSuccess: r => toast.success(`${r.moved} → ${r.to}`),
    onError: (e, v, ctx) => {
      // Refused by the tracker: the card goes back, with its reason.
      if (ctx?.previous) utils.issues.all.setData(BUCKET_SCOPE, ctx.previous);
      // The way there asks for fields: its form, instead of an error.
      const fields = (e.data as { fields?: Record<string, string> } | null | undefined)?.fields;
      if (fields && v.toStatus && v.connectionId) setAsking({ key: v.key, connectionId: v.connectionId, target: { toStatus: v.toStatus } });
      else toast.error(e.message);
    },
    onSettled: (_r, _e, v) => {
      // Transitions depend on the status just changed.
      void utils.issues.transitions.reset({ key: v.key });
      void utils.issues.get.invalidate({ key: v.key });
      void utils.issues.list.invalidate();
      return utils.issues.all.invalidate();
    },
  });

  // My work only: issues assigned to me, most relevant first in each column.
  const rows = useMemo(
    () =>
      query.data
        ? visibleIssues(query.data)
            .filter(i => i.isMine && (view.connection === 0 || i.connectionId === view.connection))
            .sort(byRelevance)
        : undefined,
    [query.data, view.connection]
  );
  const needle = term.trim().toLowerCase();
  const shownRows = useMemo(
    () => (rows ?? []).filter(i => !needle || i.key.toLowerCase().includes(needle) || i.summary.toLowerCase().includes(needle)),
    [rows, needle]
  );

  // The trackers on the board: those with cards, those the bucket takes, the one chosen.
  const sourceIds = useMemo(() => {
    const ids = new Set<number>((rows ?? []).map(r => r.connectionId));
    for (const s of active?.sources ?? []) ids.add(s.connectionId);
    if (view.connection) return [view.connection];
    return [...ids].filter(id => connections.some(c => c.id === id)).sort((a, b) => a - b);
  }, [rows, active, view.connection, connections]);

  const lanes: Lane[] = useMemo(() => {
    const seen = (connectionId: number) => {
      // Every status the tracker has shown (an empty column still takes a drop), and those on cards now.
      const m = new Map<string, string>();
      for (const s of statuses) if (s.connectionId === connectionId) m.set(s.status, s.category);
      for (const r of rows ?? []) if (r.connectionId === connectionId) m.set(r.status, r.category);
      return m;
    };
    if (mode === "custom") {
      return [{ connectionId: null, label: "", columns: customColumns.map(c => ({ kind: "custom" as const, id: `x:${c.id}`, statuses: c.statuses, title: c.name, category: "" })) }];
    }
    if (mode === "category") {
      const present = new Set<string>();
      for (const id of sourceIds) for (const cat of seen(id).values()) present.add(cat);
      return [
        {
          connectionId: null,
          label: "",
          columns: CATEGORY_ORDER.filter(c => present.has(c)).map(c => ({ kind: "category" as const, id: `k:${c}`, category: c, title: categoryTitle(c) })),
        },
      ];
    }
    return sourceIds.map(id => ({
      connectionId: id,
      label: nameOf(id),
      columns: [...seen(id).entries()]
        .sort(([a, ca], [b, cb]) => categoryRank(ca) - categoryRank(cb) || a.localeCompare(b))
        .map(([status, category]) => ({ kind: "status" as const, id: `s:${id}:${status}`, connectionId: id, status, title: status, category })),
    }));
    // nameOf reads connections, listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, customColumns, sourceIds, statuses, rows, connections]);
  const allColumns = lanes.flatMap(l => l.columns);

  // Dragging: only the columns its own tracker can take it to accept the drop.
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const waysOf = async (card: Row): Promise<Way[]> => {
    const list = await utils.issues.transitions.fetch({ key: card.key, connectionId: card.connectionId }, { staleTime: 60_000 });
    return list.map(w => ({ toStatus: w.toStatus, toCategory: w.toCategory, executable: w.executable }));
  };
  const prefetch = (card: Row) => void utils.issues.transitions.prefetch({ key: card.key, connectionId: card.connectionId }, { staleTime: 60_000 });
  const startDrag = (card: Row) => {
    const cached = utils.issues.transitions.getData({ key: card.key, connectionId: card.connectionId });
    setDragging({ card, ways: cached ? cached.map(w => ({ toStatus: w.toStatus, toCategory: w.toCategory, executable: w.executable })) : null });
    if (!cached) {
      void waysOf(card)
        .then(ways => setDragging(d => (d && d.card === card ? { card, ways } : d)))
        .catch(() => setDragging(d => (d && d.card === card ? { card, ways: [] } : d)));
    }
  };
  const targets = useMemo(
    () => (dragging?.ways ? dropTargets({ connectionId: dragging.card.connectionId, status: dragging.card.status }, dragging.ways, allColumns) : new Map<string, string[]>()),
    [dragging, allColumns]
  );
  const go = (card: Row, to: string[]) => {
    if (to.length === 1) transition.mutate({ key: card.key, connectionId: card.connectionId, toStatus: to[0] });
    else if (to.length > 1) setChoosing({ card, statuses: to });
  };
  /** A card moved from its menu or by keyboard: the column's statuses it can reach. */
  const moveTo = async (card: Row, columnId: string) => {
    const col = allColumns.find(c => c.id === columnId);
    if (!col) return;
    const to = reachable({ connectionId: card.connectionId, status: card.status }, await waysOf(card), col);
    if (to.length === 0) toast.error(t("pages.board.cantGo", { key: card.key, column: col.title }));
    else go(card, to);
  };

  const onDrop = (e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    setDragOver(null);
    const d = dragging;
    setDragging(null);
    // Only our own cards: dropped text or links from elsewhere are ignored.
    if (!d || !e.dataTransfer.types.includes("application/x-from-status")) return;
    go(d.card, targets.get(columnId) ?? []);
  };

  const cardsOf = (col: BoardColumn) =>
    shownRows.filter(r => columnOf({ connectionId: r.connectionId, status: r.status, category: r.category }, [col]) === col.id);
  // Custom columns: cards no column takes, said apart (they can't be dropped back there).
  const unmapped = mode === "custom" ? shownRows.filter(r => columnOf({ connectionId: r.connectionId, status: r.status, category: r.category }, allColumns) === null) : [];

  const renderColumn = (col: Lane["columns"][number]) => {
    const items = cardsOf(col);
    const isDone = col.category !== "" && isClosed(col.category);
    const expanded = showAllDone.has(col.id);
    const hidden = isDone && !expanded ? Math.max(0, items.length - DONE_LIMIT) : 0;
    const shown = hidden ? items.slice(0, DONE_LIMIT) : items;
    // While a card is dragged: on where it can go, off (and dimmed) elsewhere; its own column stays as is.
    const own = dragging ? columnOf({ connectionId: dragging.card.connectionId, status: dragging.card.status, category: dragging.card.category }, [col]) === col.id : false;
    const allowed = targets.has(col.id);
    const off = !!dragging && !own && !allowed;
    const dropHandlers = {
      onDragOver: (e: React.DragEvent) => {
        // Not a place for it: no drop cursor, no highlight.
        if (!allowed) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(col.id);
      },
      onDragLeave: () => setDragOver(v => (v === col.id ? null : v)),
      onDrop: (e: React.DragEvent) => onDrop(e, col.id),
    };
    const dot = col.category ? <Dot tone={statusCategoryDotTone(col.category)} /> : null;
    if (collapsed.has(col.id)) {
      return (
        <section
          key={col.id}
          aria-label={t("pages.board.collapsedLabel", { status: col.title })}
          data-drop={dragging ? (allowed ? "on" : "off") : undefined}
          className={cn("flex w-11 shrink-0 snap-start flex-col transition-opacity", off && "opacity-40")}
          {...dropHandlers}
        >
          <button
            type="button"
            onClick={() => toggleCollapsed(col.id)}
            title={t("pages.board.expandTitle", { status: col.title })}
            aria-label={t("pages.board.expandLabel", { status: col.title, count: items.length })}
            aria-expanded={false}
            className={cn(
              "flex flex-1 flex-col items-center gap-2 rounded-lg border bg-card py-3 text-body-sm font-medium transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              dragOver === col.id && "bg-muted/60"
            )}
          >
            <ChevronsLeftRight className="h-4 w-4 text-muted-foreground" aria-hidden />
            {dot}
            <span className="text-muted-foreground tabular">{items.length}</span>
            <span className="whitespace-nowrap [writing-mode:vertical-rl]">{col.title}</span>
          </button>
        </section>
      );
    }
    return (
      <section
        key={col.id}
        aria-label={col.title}
        data-drop={dragging ? (allowed ? "on" : "off") : undefined}
        className={cn(
          "flex min-h-0 min-w-[280px] flex-1 basis-0 snap-start flex-col rounded-xl transition-opacity",
          dragOver === col.id && "bg-muted/60",
          allowed && "ring-2 ring-inset ring-primary-strong/30",
          off && "opacity-40"
        )}
        {...dropHandlers}
      >
        <div className="mb-2 flex shrink-0 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-body-sm font-medium">
          {dot}
          <h2 className="truncate">{col.title}</h2>
          <span className="text-muted-foreground tabular">{items.length}</span>
          <Button asChild variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground">
            <Link to="/issues" aria-label={t("pages.board.openCatalog", { status: col.title })}>
              <Plus className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => toggleCollapsed(col.id)}
            aria-expanded
            aria-label={t("pages.board.collapseLabel", { status: col.title })}
            title={t("pages.board.collapseTitle")}
            className="text-muted-foreground"
          >
            <ChevronsRightLeft className="h-4 w-4" />
          </Button>
        </div>
        <div
          data-scroll-key={`board-col-${col.id}`}
          className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-2 overflow-y-auto max-lg:max-h-[70dvh]"
        >
          {shown.length === 0 && (
            <div className="grid justify-items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center text-caption text-muted-foreground">
              <span aria-hidden className="block h-10 w-12">
                <Illustration kind="inbox" className="origin-top-left scale-50" />
              </span>
              {t("pages.board.noIssues")}
            </div>
          )}
          {shown.map(i => (
            <BoardCard
              key={issueId(i)}
              issue={i}
              columns={allColumns}
              onMove={columnId => void moveTo(i, columnId)}
              onDragStart={() => startDrag(i)}
              onDragEnd={() => {
                setDragging(null);
                setDragOver(null);
              }}
              onPrefetch={() => prefetch(i)}
            />
          ))}
          {hidden > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setShowAllDone(s => new Set(s).add(col.id))}>
              {t("pages.board.showAll", { hidden })}
            </Button>
          )}
          {isDone && expanded && items.length > DONE_LIMIT && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setShowAllDone(s => {
                  const n = new Set(s);
                  n.delete(col.id);
                  return n;
                })
              }
            >
              {t("pages.board.showLess")}
            </Button>
          )}
        </div>
      </section>
    );
  };

  let body: React.ReactNode;
  if (query.isPending) {
    body = (
      <div className="flex gap-3 overflow-hidden">
        {[0, 1, 2].map(i => (
          <div key={i} className="grid min-w-[280px] flex-1 content-start gap-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ))}
      </div>
    );
  } else if (query.error) {
    body = <ErrorState message={query.error.message} onRetry={() => query.refetch()} />;
  } else if ((rows ?? []).length === 0) {
    body = <EmptyState art="inbox" title={t("pages.board.noIssues")} message={t("pages.board.emptyMessage", { provider })} />;
  } else {
    const several = lanes.length > 1;
    body = (
      <div className={cn("flex min-h-0 flex-1 flex-col gap-4", several && "overflow-y-auto")}>
        {lanes.map(lane => (
          <div
            key={lane.connectionId ?? "all"}
            data-lane={lane.connectionId ?? "all"}
            role={several ? "group" : undefined}
            aria-label={several ? lane.label : undefined}
            className={cn("flex min-h-0 flex-col", !several && "flex-1")}
          >
            {several && <h2 className="mb-2 text-body-sm font-semibold text-muted-foreground">{lane.label}</h2>}
            <div
              data-scroll-key={`board-columns-${lane.connectionId ?? "all"}`}
              className="-mx-1 flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto px-1 [scrollbar-gutter:stable]"
            >
              {lane.columns.map(renderColumn)}
              {mode === "custom" && unmapped.length > 0 && (
                <section aria-label={t("pages.board.unmapped")} className="flex min-w-[280px] flex-1 basis-0 flex-col rounded-xl opacity-80">
                  <div className="mb-2 rounded-lg border border-dashed px-2.5 py-1.5 text-body-sm font-medium text-muted-foreground">
                    {t("pages.board.unmapped")} <span className="tabular">{unmapped.length}</span>
                  </div>
                  <div className="grid content-start gap-2">
                    {unmapped.map(i => (
                      <BoardCard
                        key={issueId(i)}
                        issue={i}
                        columns={allColumns}
                        onMove={columnId => void moveTo(i, columnId)}
                        onDragStart={() => startDrag(i)}
                        onDragEnd={() => setDragging(null)}
                        onPrefetch={() => prefetch(i)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    // Fills the panel on desktop: only a column with too many cards scrolls.
    <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
      <TransitionDialog
        issueKey={asking?.key ?? ""}
        connectionId={asking?.connectionId}
        target={asking?.target ?? null}
        onClose={() => setAsking(null)}
        onMoved={r => {
          setAsking(null);
          toast.success(`${r.moved} → ${r.to}`);
          void utils.issues.transitions.reset();
          void utils.issues.list.invalidate();
          void utils.issues.all.invalidate();
        }}
      />
      <Dialog open={choosing !== null} onOpenChange={o => !o && setChoosing(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("pages.board.chooseTitle", { key: choosing?.card.key ?? "" })}</DialogTitle>
            <DialogDescription>{t("pages.board.chooseHint")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {choosing?.statuses.map(s => (
              <Button
                key={s}
                variant="outline"
                onClick={() => {
                  transition.mutate({ key: choosing.card.key, connectionId: choosing.card.connectionId, toStatus: s });
                  setChoosing(null);
                }}
              >
                {s}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <PageHeader
        className="shrink-0"
        title={t("pages.board.title")}
        description={
          cut
            ? `${t("pages.board.description", { provider })} ${t("pages.board.cut", { shown: cut.limit, total: cut.total })}`
            : t("pages.board.description", { provider })
        }
        actions={
          <>
            <BoardScope connection={view.connection} onConnection={c => setView({ connection: c })} />
            <SegmentedControl<BoardMode>
              label={t("pages.board.mode")}
              value={mode}
              onChange={setMode}
              options={[
                { value: "lanes", label: t("pages.board.modeLanes"), icon: Rows3 },
                { value: "category", label: t("pages.board.modeCategory"), icon: Columns3 },
                ...(customColumns.length > 0 ? [{ value: "custom" as const, label: t("pages.board.modeCustom"), icon: LayoutGrid }] : []),
              ]}
            />
            <Button
              variant="outline"
              aria-pressed={panel !== "closed"}
              className={cn(
                "max-lg:hidden",
                panel !== "closed" &&
                  "border-primary-strong/40 bg-primary-soft text-primary-strong"
              )}
              onClick={() =>
                pinboardPanel.set(panel === "closed" ? "open" : "closed")
              }
            >
              <Pin className="h-4 w-4 -rotate-12" />
              {t("pages.board.pinboard")}
            </Button>
            <Button
              variant="outline"
              className="lg:hidden"
              onClick={() => pinboardSheet.set(true)}
            >
              <Pin className="h-4 w-4 -rotate-12" />
              {t("pages.board.pinboard")}
            </Button>
            <div className="relative">
              <Search
                className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                className="w-full pl-8 sm:w-56"
                placeholder={t("pages.board.searchPlaceholder")}
                aria-label={t("pages.board.search")}
                value={term}
                onChange={e => setTerm(e.target.value)}
              />
            </div>
          </>
        }
      />
      <PanelSection className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
          {/* Lavagna on the right: a rail when closed, 420px, or wide. */}
          {panel === "closed" ? (
            <button
              type="button"
              onClick={() => pinboardPanel.set("open")}
              aria-label={t("pages.board.openPinboardLabel", { count: pinned })}
              title={t("pages.board.openPinboardTitle")}
              className="hidden w-11 shrink-0 flex-col items-center gap-2 rounded-lg border bg-card py-3 text-body-sm font-medium outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/40 lg:flex"
            >
              <Pin
                className="h-4 w-4 -rotate-12 text-muted-foreground"
                aria-hidden
              />
              <span className="text-muted-foreground tabular">{pinned}</span>
              <span className="whitespace-nowrap [writing-mode:vertical-rl]">
                {t("pages.board.pinboard")}
              </span>
            </button>
          ) : (
            <Pinboard
              className={cn(
                "hidden shrink-0 lg:flex",
                panel === "wide" ? "w-[62%]" : "w-[420px]"
              )}
            />
          )}
        </div>
      </PanelSection>
      {/* Small screens: the lavagna slides in from the right. */}
      <Sheet open={mobileBoard} onOpenChange={pinboardSheet.set}>
        <SheetContent
          side="right"
          hideClose
          className="flex w-full flex-col p-3 sm:max-w-lg lg:hidden"
        >
          <SheetTitle className="sr-only">{t("pages.board.pinboard")}</SheetTitle>
          <SheetDescription className="sr-only">
            {t("pages.board.pinboardDescription")}
          </SheetDescription>
          <Pinboard
            className="min-h-0 flex-1"
            onClose={() => pinboardSheet.set(false)}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
