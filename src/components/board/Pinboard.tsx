import { toastError, errorText } from "@/lib/errorText";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Focus,
  FolderInput,
  Maximize2,
  Minimize2,
  Pencil,
  Pin,
  Plus,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
  Tag,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { openCreateIssue } from "@/lib/createIssue";
import {
  clampToCanvas,
  CANVAS_H,
  CANVAS_W,
  NOTE_SIZE,
  type NoteColor,
} from "@contracts/pinboard";
import {
  pinboardBoard,
  pinboardPanel,
  usePinboardBoardId,
  usePinboardPanel,
} from "@/hooks/usePinboardPanel";
import {
  centreOn,
  notesBounds,
  offscreenByEdge,
  type Edge,
} from "@/lib/pinboardView";
import { PostIt, type PostItData } from "@/components/board/PostIt";
import { Strings } from "@/components/board/Strings";
import { pinboardLive } from "@/lib/pinboardLive";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBuckets } from "@/hooks/useBuckets";
import { ErrorState } from "@/components/app/States";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useProviderName } from "@/hooks/useConnections";
import { surface } from "@/components/app/surface";
import { t } from "@/i18n";
import { issuePath } from "@/lib/issues";
import { isTyping } from "@/lib/dom";
import { PinSearch } from "@/components/board/PinSearch";
import { FollowTagDialog } from "@/components/board/FollowTagDialog";

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const EDGE_ICON = { up: ArrowUp, down: ArrowDown, left: ArrowLeft, right: ArrowRight };
const edgeLabel = (edge: Edge) =>
  ({
    up: t("views.board.pinboard.edgeUp"),
    down: t("views.board.pinboard.edgeDown"),
    left: t("views.board.pinboard.edgeLeft"),
    right: t("views.board.pinboard.edgeRight"),
  })[edge];
const EDGE_PLACE: Record<Edge, string> = {
  up: "left-1/2 top-2 -translate-x-1/2",
  down: "bottom-2 left-1/2 -translate-x-1/2",
  left: "left-2 top-1/2 -translate-y-1/2",
  right: "right-2 top-1/2 -translate-y-1/2",
};
const EDGE_FADE: Record<Edge, string> = {
  up: "inset-x-0 top-0 h-8 bg-gradient-to-b",
  down: "inset-x-0 bottom-0 h-8 bg-gradient-to-t",
  left: "inset-y-0 left-0 w-8 bg-gradient-to-r",
  right: "inset-y-0 right-0 w-8 bg-gradient-to-l",
};

type Offscreen = ReturnType<typeof offscreenByEdge<PostItData>>;
const NONE: Offscreen = {
  up: { count: 0, nearest: null },
  down: { count: 0, nearest: null },
  left: { count: 0, nearest: null },
  right: { count: 0, nearest: null },
};

/**
 * The lavagne: named boards of notes pinned by hand on a fixed canvas
 * (1600×1200). No scrollbars: drag the empty board (or wheel / trackpad) to
 * move around; pills on the edges say how many notes lie beyond and bring
 * the nearest into view. Cards dragged from the Board land where dropped.
 */
export function Pinboard({
  className,
  onClose,
  resizable = true,
  closable = true,
  connectionId,
}: {
  className?: string;
  /** The tracker the Board shows (none or 0: every one): its notes, and its counts. */
  connectionId?: number;
  /** Where it lives in a sheet (small screens): closing closes the sheet. */
  onClose?: () => void;
  /** Widen/narrow the Board's panel; off where it is not that panel. */
  resizable?: boolean;
  /** A close button; off where it is a page of its own. */
  closable?: boolean;
}) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const panel = usePinboardPanel();
  const provider = useProviderName();
  const storedBoard = usePinboardBoardId();
  // Lists and counts with one filter: what the Board shows (the device's bucket, its tracker).
  const scope = connectionId ? { connectionId } : undefined;
  const boardsQuery = trpc.pinboard.boards.useQuery(scope);
  const boards = boardsQuery.data ?? [];
  // Under a bucket: its own boards, then those for every bucket (others never show).
  // Grouped as the server chose them, never by this page's own idea of the bucket.
  const { buckets, active: bucket } = useBuckets();
  const own = boards.filter(b => b.group !== "shared");
  const shared = boards.filter(b => b.group === "shared");
  const board = boards.find(b => b.id === storedBoard) ?? boards[0];
  const boardId = board?.id;
  // Fresh boards without the remembered one (moved to another bucket, a switch): the shown one
  // becomes it, here and wherever else the board is drawn. Checked on new data only, so a board
  // just created and chosen is not undone before the list that has it arrives.
  const freshBoards = boardsQuery.data;
  useEffect(() => {
    const stored = pinboardBoard.get();
    const first = freshBoards?.[0];
    if (first && stored !== null && !freshBoards.some(b => b.id === stored)) pinboardBoard.set(first.id);
  }, [freshBoards]);
  // A board that follows a tag: what the tracker says, read-only.
  const follow = board?.follow ?? null;
  const listInput = { boardId, ...scope };
  const list = trpc.pinboard.list.useQuery(listInput, { enabled: boardId !== undefined });
  const [zoom, setZoom] = useState(1);
  const [over, setOver] = useState(false);
  const [panning, setPanning] = useState(false);
  const [edges, setEdges] = useState<Offscreen>(NONE);
  const [naming, setNaming] = useState<"create" | "rename" | null>(null);
  const [following, setFollowing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pan = useRef<{ px: number; py: number; sl: number; st: number } | null>(null);
  const notes = useMemo(() => list.data ?? [], [list.data]);
  type Note = (typeof notes)[number];

  const refresh = async () => {
    // The boards first: a list asked for a board this device no longer shows would come back
    // with another board's notes, kept under this one's key.
    await utils.pinboard.boards.invalidate();
    // Where each issue is pinned too: the issue page's pin button follows the board.
    await Promise.all([utils.pinboard.list.invalidate(), utils.pinboard.where.invalidate()]);
  };
  const fail = (e: unknown) => {
    toastError(e);
    void refresh();
  };
  const setNotes = (f: (old: Note[]) => Note[]) =>
    utils.pinboard.list.setData(listInput, old => (old ? f(old) : old));
  /** Optimistic local change, then the server; any error reloads the truth. */
  const patch = (id: number, p: Partial<PostItData>, send: () => Promise<unknown>) => {
    setNotes(old => old.map(n => (n.id === id ? { ...n, ...p } : n)));
    queue(id, send).catch(fail);
  };
  // One request at a time per note, so quick moves land in order.
  const chains = useRef(new Map<number, Promise<unknown>>());
  const queue = (id: number, send: () => Promise<unknown>) => {
    const next = (chains.current.get(id) ?? Promise.resolve()).then(send, send);
    chains.current.set(id, next.catch(() => undefined));
    return next;
  };
  const nudge = (id: number, dx: number, dy: number) => {
    const n = utils.pinboard.list.getData(listInput)?.find(x => x.id === id);
    if (!n) return;
    const p = clampToCanvas(n.x + dx, n.y + dy);
    patch(id, p, () => utils.client.pinboard.update.mutate({ id, ...onFollowed(id), ...p }));
  };
  // A followed board's post-its (negative ids, never stored as pins) are placed on that board.
  const onFollowed = (id: number) => (id < 0 && boardId !== undefined ? { boardId } : {});
  // Raise by z only: reordering the list would move the DOM node mid-drag.
  const toFront = (id: number) =>
    setNotes(old => {
      const top = Math.max(0, ...old.map(x => x.z));
      return old.map(x => (x.id === id && x.z !== top ? { ...x, z: top + 1 } : x));
    });

  const add = async (input: { issueKey?: string; connectionId?: number; x?: number; y?: number; note?: string }) => {
    try {
      const r = await utils.client.pinboard.add.mutate({ ...input, boardId });
      await refresh();
      if (r.existed) toast.info(t("views.board.pinboard.alreadyHere", { key: input.issueKey ?? "" }));
      return r;
    } catch (e) {
      fail(e);
      return null;
    }
  };

  const remove = async (n: PostItData) => {
    setNotes(old => old.filter(x => x.id !== n.id));
    try {
      const removed = await utils.client.pinboard.remove.mutate({ id: n.id });
      void utils.pinboard.boards.invalidate();
      void utils.pinboard.where.invalidate();
      if (n.issueNoteId && n.issueKey) void utils.issueNotes.list.invalidate({ issueKey: n.issueKey, connectionId: n.connectionId ?? undefined });
      toast.success(n.issueNoteId ? t("views.board.pinboard.unhungNote") : n.issueKey ? t("views.board.pinboard.unpinnedIssue", { key: n.issueKey }) : t("views.board.pinboard.unpinnedNote"), {
        action: {
          label: t("views.board.pinboard.undo"),
          onClick: () =>
            void utils.client.pinboard.restore
              .mutate({
                boardId: removed.boardId ?? boardId ?? 0,
                issueKey: removed.issueKey,
                connectionId: removed.connectionId ?? undefined,
                issueNoteId: removed.issueNoteId,
                note: removed.note,
                color: removed.color as NoteColor,
                x: removed.x,
                y: removed.y,
                rotation: removed.rotation,
              })
              .then(refresh, fail),
        },
      });
    } catch (e) {
      fail(e);
    }
  };

  // Elsewhere: the other boards pinned by hand (a followed one shows the tracker's, nothing goes there).
  const elsewhere = boards.filter(b => !b.follow && b.id !== boardId).map(b => ({ id: b.id, name: b.name }));

  /** A post-it to another board, moved or copied; from a followed board, its issue pinned there. */
  const copy = async (n: PostItData, to: number, move: boolean) => {
    const name = n.issueKey ?? t("views.board.pinboard.theNote");
    try {
      if (n.id < 0) {
        // Shown by a followed board, never stored: the issue is pinned there.
        if (!n.issueKey) return;
        const r = await utils.client.pinboard.add.mutate({ boardId: to, issueKey: n.issueKey, connectionId: n.connectionId ?? undefined });
        void refresh();
        toast.success(t(r.existed ? "ui.pin.existing" : "ui.pin.added", { key: n.issueKey, board: r.boardName }));
        return;
      }
      if (move) setNotes(old => old.filter(x => x.id !== n.id));
      const r = await utils.client.pinboard.copy.mutate({ id: n.id, boardId: to, move });
      void refresh();
      const removed = r.removed;
      toast.success(
        t(r.existed ? "views.board.pinboard.noteAlreadyThere" : move ? "views.board.pinboard.noteMovedTo" : "views.board.pinboard.noteCopiedTo", { name, board: r.boardName }),
        removed
          ? {
              action: {
                label: t("views.board.pinboard.undo"),
                onClick: () =>
                  void (r.existed ? Promise.resolve() : utils.client.pinboard.remove.mutate({ id: r.id }))
                    .then(() =>
                      utils.client.pinboard.restore.mutate({
                        boardId: removed.boardId ?? boardId ?? 0,
                        issueKey: removed.issueKey,
                        connectionId: removed.connectionId ?? undefined,
                        issueNoteId: removed.issueNoteId,
                        note: removed.note,
                        color: removed.color as NoteColor,
                        x: removed.x,
                        y: removed.y,
                        rotation: removed.rotation,
                      })
                    )
                    .then(refresh, fail),
              },
            }
          : undefined
      );
    } catch (e) {
      fail(e);
    }
  };

  const createIssue = (n: PostItData) => {
    const [first, ...rest] = n.note.split("\n");
    openCreateIssue({
      summary: first.trim(),
      description: rest.join("\n").trim(),
      onCreated: (key, connectionId) =>
        void utils.client.pinboard.link.mutate({ id: n.id, issueKey: key, connectionId }).then(refresh, fail),
    });
  };

  /** Canvas position under the pointer, centring the note on it. */
  const at = (clientX: number, clientY: number) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r) return { x: 32, y: 32 };
    return {
      x: (clientX - r.left) / zoom - NOTE_SIZE / 2,
      y: (clientY - r.top) / zoom - 24,
    };
  };

  // ---- what lies beyond the edges ----
  const frame = useRef(0);
  const measure = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      setEdges(
        offscreenByEdge(notes, {
          left: el.scrollLeft / zoom,
          top: el.scrollTop / zoom,
          width: el.clientWidth / zoom,
          height: el.clientHeight / zoom,
        })
      );
    });
  }, [notes, zoom]);
  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [measure]);

  const scrollToCanvas = (x: number, y: number) =>
    scroller.current?.scrollTo({
      left: x * zoom,
      top: y * zoom,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  const reveal = (n: PostItData) => {
    const el = scroller.current;
    if (!el) return;
    const p = centreOn(n, { width: el.clientWidth / zoom, height: el.clientHeight / zoom });
    scrollToCanvas(p.x, p.y);
  };
  const frameAll = () => {
    const b = notesBounds(notes);
    const el = scroller.current;
    if (!b || !el) return;
    scrollToCanvas(
      Math.max(0, b.left + b.width / 2 - el.clientWidth / zoom / 2),
      Math.max(0, b.top + b.height / 2 - el.clientHeight / zoom / 2)
    );
  };

  // Pinned from the search: brought into view where it landed.
  const search = useRef<HTMLInputElement>(null);
  const pinFound = async (i: { key: string; connectionId: number }) => {
    const r = await add({ issueKey: i.key, connectionId: i.connectionId });
    const landed = r && utils.pinboard.list.getData(listInput)?.find(n => n.id === r.id);
    if (landed) reveal(landed);
  };
  const onBoard = useMemo(
    () => new Set(notes.flatMap(n => (n.issueKey && !n.issueNoteId ? [`${n.connectionId}:${n.issueKey}`] : []))),
    [notes]
  );

  const wide = panel === "wide";
  return (
    <section
      aria-label={t("views.board.pinboard.title")}
      className={cn("flex min-h-0 min-w-0 flex-col gap-2", className)}
      onKeyDown={e => {
        // "/" inside the pinboard: its search.
        if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || !search.current) return;
        e.preventDefault();
        search.current.focus();
      }}
    >
      <div className="flex shrink-0 items-center gap-1">
        <Pin className="h-4 w-4 shrink-0 -rotate-12 text-muted-foreground" aria-hidden />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 font-display text-body font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-label={t("views.board.pinboard.switch", { name: board?.name ?? "…" })}
            >
              <span className="truncate">{board?.name ?? t("views.board.pinboard.title")}</span>
              <span className="text-body-sm font-normal text-muted-foreground tabular">
                {notes.length}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>
              {bucket ? t("views.board.pinboard.inBucket", { bucket: bucket.name }) : t("views.board.pinboard.boards")}
            </DropdownMenuLabel>
            {own.map(b => (
              <BoardItem key={b.id} b={b} current={b.id === boardId} tag={b.group === "all" && b.bucket ? b.bucket.name : null} />
            ))}
            {bucket && own.length === 0 && (
              <p className="px-2 py-1.5 text-body-sm text-muted-foreground">{t("views.board.pinboard.noneInBucket")}</p>
            )}
            {shared.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("views.board.pinboard.everyBucket")}</DropdownMenuLabel>
                {shared.map(b => (
                  <BoardItem key={b.id} b={b} current={b.id === boardId} tag={t("views.board.pinboard.allTag")} />
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setNaming("create")}>
              <Plus className="h-4 w-4" /> {t("views.board.pinboard.newBoard")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setFollowing(true)}>
              <Tag className="h-4 w-4" /> {t("views.board.pinboard.followTag")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!board} onSelect={() => setNaming("rename")}>
              <Pencil className="h-4 w-4" /> {t("views.board.pinboard.rename")}
            </DropdownMenuItem>
            {board && buckets.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderInput className="h-4 w-4" /> {t("views.board.pinboard.scope")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  <DropdownMenuRadioGroup
                    value={String(board.bucket?.id ?? "all")}
                    onValueChange={v => {
                      const bucketId = v === "all" ? null : Number(v);
                      void utils.client.pinboard.setBoardScope
                        .mutate({ id: board.id, bucketId })
                        .then(() => {
                          const name = bucketId === null ? null : buckets.find(x => x.id === bucketId)?.name;
                          toast.success(name ? t("views.board.pinboard.movedTo", { name: board.name, bucket: name }) : t("views.board.pinboard.movedToAll", { name: board.name }));
                          return refresh();
                        }, fail);
                    }}
                  >
                    <DropdownMenuRadioItem value="all">{t("views.board.pinboard.everyBucket")}</DropdownMenuRadioItem>
                    {buckets.map(x => (
                      <DropdownMenuRadioItem key={x.id} value={String(x.id)}>
                        <span className="truncate">{x.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuItem
              // One board pinned by hand always stays (where a pin lands).
              disabled={boards.length < 2 || (!follow && boards.filter(b => !b.follow).length < 2)}
              onSelect={() => setConfirmDelete(true)}
              className="text-danger focus:text-danger"
            >
              <Trash2 className="h-4 w-4" /> {t("views.board.pinboard.deleteBoard")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-auto flex items-center">
          {!follow && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void add({ note: "" })}
              title={t("views.board.pinboard.newNoteHint")}
              disabled={!board}
            >
              <Plus className="h-4 w-4" />
              {t("views.board.pinboard.note")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("views.board.pinboard.frameAllLabel")}
            title={t("views.board.pinboard.frameAll")}
            disabled={notes.length === 0}
            onClick={frameAll}
          >
            <Focus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={zoom === 1 ? t("views.board.pinboard.zoomOut") : t("views.board.pinboard.zoomIn")}
            title={zoom === 1 ? t("views.board.pinboard.zoomOutHint") : t("views.board.pinboard.zoomInHint")}
            onClick={() => setZoom(z => (z === 1 ? 0.75 : 1))}
          >
            {zoom === 1 ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
          </Button>
          {resizable && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="max-lg:hidden"
              aria-label={wide ? t("views.board.pinboard.narrowLabel") : t("views.board.pinboard.widenLabel")}
              title={wide ? t("views.board.pinboard.narrow") : t("views.board.pinboard.widen")}
              onClick={() => pinboardPanel.set(wide ? "open" : "wide")}
            >
              {wide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          )}
          {closable && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("views.board.pinboard.closeLabel")}
              title={t("views.board.pinboard.close")}
              onClick={onClose ?? (() => pinboardPanel.set("closed"))}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </span>
      </div>

      {board && !follow && <PinSearch onBoard={onBoard} onPick={i => void pinFound(i)} inputRef={search} />}
      {follow && (
        <p className="flex shrink-0 items-center gap-1.5 px-1.5 text-caption text-muted-foreground">
          <Tag className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {t(follow.field === "component" ? "views.board.pinboard.followsComponent" : "views.board.pinboard.followsLabel", { value: follow.value })}
          </span>
        </p>
      )}
      {board && board.hidden > 0 && (
        <p className="shrink-0 px-1.5 text-caption text-muted-foreground">
          {bucket
            ? t("views.board.pinboard.hiddenByBucket", { count: board.hidden, bucket: bucket.name })
            : t("views.board.pinboard.hiddenByTracker", { count: board.hidden })}
        </p>
      )}
      <div {...surface("ground")} className="paper-board relative min-h-0 flex-1 overflow-hidden rounded-xl border">
        <div
          ref={scroller}
          tabIndex={0}
          aria-label={t("views.board.pinboard.area")}
          className={cn(
            "no-scrollbar h-full overflow-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
            panning ? "cursor-grabbing" : "cursor-grab"
          )}
          onScroll={measure}
          onPointerDown={e => {
            const target = e.target as Element;
            // A post-it's menu (a portal) bubbles here too: no pan from it.
            if (e.button !== 0 || !e.currentTarget.contains(target) || target.closest("[data-postit], button, a, textarea, input")) return;
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            pan.current = { px: e.clientX, py: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
            setPanning(true);
          }}
          onPointerMove={e => {
            const p = pan.current;
            if (!p) return;
            e.currentTarget.scrollLeft = p.sl - (e.clientX - p.px);
            e.currentTarget.scrollTop = p.st - (e.clientY - p.py);
          }}
          onPointerUp={e => {
            if (!pan.current) return;
            pan.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            setPanning(false);
          }}
          onKeyDown={e => {
            if (e.target !== e.currentTarget) return;
            const d: Record<string, [number, number]> = {
              ArrowLeft: [-120, 0],
              ArrowRight: [120, 0],
              ArrowUp: [0, -120],
              ArrowDown: [0, 120],
            };
            const m = d[e.key];
            if (!m) return;
            e.preventDefault();
            e.currentTarget.scrollBy({ left: m[0], top: m[1] });
          }}
        >
          {list.error ? (
            <div className="grid h-full place-items-center">
              <ErrorState message={errorText(list.error)} onRetry={() => void list.refetch()} />
            </div>
          ) : (
            <div
              ref={canvas}
              className="relative"
              style={{ width: CANVAS_W * zoom, height: CANVAS_H * zoom }}
              onDragOver={e => {
                // A board that follows a tag takes nothing pinned by hand.
                if (follow || !e.dataTransfer.types.includes("text/plain")) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={e => {
                setOver(false);
                // A board card: its key on its connection (any tracker's shape of key).
                const key = e.dataTransfer.getData("text/plain").trim();
                const connectionId = Number(e.dataTransfer.getData("application/x-connection")) || undefined;
                if (!key || (!connectionId && !/^[A-Z][A-Z0-9_]*-\d+$/i.test(key))) return;
                e.preventDefault();
                void add({ issueKey: connectionId ? key : key.toUpperCase(), connectionId, ...at(e.clientX, e.clientY) });
              }}
            >
              <div
                className={cn(
                  "absolute left-0 top-0",
                  over && "bg-primary-soft/40 ring-2 ring-inset ring-primary-strong/40"
                )}
                style={{
                  width: CANVAS_W,
                  height: CANVAS_H,
                  transform: `scale(${zoom})`,
                  transformOrigin: "0 0",
                }}
              >
                {!board && boardsQuery.isSuccess && bucket && (
                  <div {...surface("note")} className="note-shadow absolute left-10 top-12 w-[20rem] rotate-[-0.8deg] rounded-sm">
                    <span {...surface("glass")} className="note-tape" aria-hidden />
                    <div className="note-paper grain rounded-sm px-5 pb-4 pt-6">
                      <p className="font-display text-heading">{t("views.board.pinboard.noneInBucketTitle", { bucket: bucket.name })}</p>
                      <p className="mt-1 text-body-sm opacity-80">{t("views.board.pinboard.noneInBucketHint")}</p>
                      <Button size="sm" className="mt-3" onClick={() => setNaming("create")}>
                        <Plus className="h-4 w-4" /> {t("views.board.pinboard.newBoard")}
                      </Button>
                    </div>
                  </div>
                )}
                {board && notes.length === 0 && !list.isPending && (
                  <div {...surface("note")} className="note-shadow absolute left-10 top-12 w-[20rem] rotate-[-0.8deg] rounded-sm">
                    <span {...surface("glass")} className="note-tape" aria-hidden />
                    <div className="note-paper grain rounded-sm px-5 pb-4 pt-6">
                      <p className="font-display text-heading">{board?.name ?? t("views.board.pinboard.yourBoard")}</p>
                      <p className="mt-1 text-body-sm opacity-80">
                        {follow ? t("views.board.pinboard.followEmpty", { value: follow.value }) : t("views.board.pinboard.emptyHint")}
                      </p>
                    </div>
                  </div>
                )}
                {notes.map(n => (
                  <PostIt
                    key={n.id}
                    n={n}
                    zoom={zoom}
                    readOnly={!!follow}
                    onFront={() => toFront(n.id)}
                    onNudge={(dx, dy) => nudge(n.id, dx, dy)}
                    onMove={(x, y) =>
                      patch(n.id, { x, y }, () =>
                        utils.client.pinboard.update.mutate({ id: n.id, ...onFollowed(n.id), x, y, toFront: true })
                      )
                    }
                    onNote={note =>
                      n.issueNoteId
                        ? // A private note: the text is the note's (the issue page shows it too).
                          patch(n.id, { noteBody: note }, () =>
                            utils.client.pinboard.update
                              .mutate({ id: n.id, note })
                              .then(() => (n.issueKey ? utils.issueNotes.list.invalidate({ issueKey: n.issueKey, connectionId: n.connectionId ?? undefined }) : undefined))
                          )
                        : patch(n.id, { note }, () =>
                            utils.client.pinboard.update.mutate({ id: n.id, note })
                          )
                    }
                    onDrag={p => pinboardLive.set(n.id, p)}
                    onColor={color =>
                      patch(n.id, { color }, () =>
                        utils.client.pinboard.update.mutate({ id: n.id, ...onFollowed(n.id), color })
                      )
                    }
                    onRemove={() => void remove(n)}
                    boards={elsewhere}
                    onCopy={(to, move) => void copy(n, to, move)}
                    onCreateIssue={() => createIssue(n)}
                    onOpen={() => n.issueKey && void navigate(issuePath({ key: n.issueKey, connectionId: n.connectionId }))}
                  />
                ))}
                <Strings notes={notes} />
              </div>
            </div>
          )}
        </div>

        {/* The board goes on: a soft fade and a pill per edge with notes beyond. */}
        {(Object.keys(EDGE_ICON) as Edge[]).map(edge => {
          const e = edges[edge];
          if (e.count === 0 || !e.nearest) return null;
          const Icon = EDGE_ICON[edge];
          const nearest = e.nearest;
          return (
            <div key={edge}>
              <div
                aria-hidden
                className={cn(
                  "pointer-events-none absolute from-muted to-transparent",
                  EDGE_FADE[edge]
                )}
              />
              <button
                type="button"
                {...surface("chip")}
                onClick={() => reveal(nearest)}
                aria-label={t("views.board.pinboard.beyondLabel", { count: e.count, edge: edgeLabel(edge) })}
                title={t("views.board.pinboard.beyond", { count: e.count, edge: edgeLabel(edge) })}
                className={cn(
                  "absolute z-[1000] flex items-center gap-1 rounded-full border bg-card/95 px-2 py-0.5 text-caption font-medium text-muted-foreground shadow-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
                  EDGE_PLACE[edge]
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                <span className="tabular">{e.count}</span>
              </button>
            </div>
          );
        })}
      </div>

      <FollowTagDialog
        open={following}
        onClose={() => setFollowing(false)}
        onPick={tag =>
          utils.client.pinboard.createBoard.mutate({ name: tag.value.slice(0, 60), follow: tag }).then(r => {
            setFollowing(false);
            pinboardBoard.set(r.id);
            toast.success(t("views.board.pinboard.created", { name: tag.value }));
            return refresh();
          }, toastError)
        }
      />
      <BoardNameDialog
        mode={naming}
        initial={naming === "rename" ? (board?.name ?? "") : ""}
        onClose={() => setNaming(null)}
        onSave={async name => {
          try {
            if (naming === "create") {
              const r = await utils.client.pinboard.createBoard.mutate({ name });
              pinboardBoard.set(r.id);
              toast.success(t("views.board.pinboard.created", { name }));
            } else if (board) {
              await utils.client.pinboard.renameBoard.mutate({ id: board.id, name });
            }
            setNaming(null);
            await refresh();
          } catch (e) {
            toastError(e);
          }
        }}
      />
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("views.board.pinboard.deleteTitle", { name: board?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {/* Every note, the ones the filter hides too: they go with the board. */}
              {follow || (board ? board.count + board.hidden : 0) === 0
                ? t("views.board.pinboard.deleteEmpty")
                : t("views.board.pinboard.deleteNotes", { count: board ? board.count + board.hidden : 0 })}{" "}
              {t("views.board.pinboard.deleteJira", { provider })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("views.board.pinboard.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                if (!board) return;
                const next = boards.find(b => b.id !== board.id);
                void utils.client.pinboard.deleteBoard
                  .mutate({ id: board.id })
                  .then(() => {
                    if (next) pinboardBoard.set(next.id);
                    toast.success(t("views.board.pinboard.deleted", { name: board.name }));
                    return refresh();
                  }, fail);
              }}
            >
              {t("views.board.pinboard.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** One board in the switcher: its name, where it belongs when that is worth saying, and its notes. */
function BoardItem({ b, current, tag }: { b: { id: number; name: string; count: number }; current: boolean; tag: string | null }) {
  return (
    <DropdownMenuItem onSelect={() => pinboardBoard.set(b.id)}>
      <Check className={cn("h-4 w-4", !current && "opacity-0")} aria-hidden />
      <span className="truncate">{b.name}</span>
      {tag && <span {...surface("chip")} className="shrink-0 rounded-sm bg-muted px-1 text-caption text-muted-foreground">{tag}</span>}
      <span className="ml-auto text-caption text-muted-foreground tabular">{b.count}</span>
    </DropdownMenuItem>
  );
}

/** Name a new board or rename the current one. */
function BoardNameDialog({
  mode,
  initial,
  onClose,
  onSave,
}: {
  mode: "create" | "rename" | null;
  initial: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  return (
    <Dialog open={mode !== null} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {mode && <BoardNameForm key={mode} mode={mode} initial={initial} onClose={onClose} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  );
}

function BoardNameForm({
  mode,
  initial,
  onClose,
  onSave,
}: {
  mode: "create" | "rename";
  initial: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ok = name.trim().length > 0 && name.trim().length <= 60;
  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (!ok) return;
        setSaving(true);
        void onSave(name.trim()).finally(() => setSaving(false));
      }}
    >
      <DialogHeader>
        <DialogTitle>{mode === "create" ? t("views.board.pinboard.newTitle") : t("views.board.pinboard.renameTitle")}</DialogTitle>
        <DialogDescription>
          {t("views.board.pinboard.nameHint")}
        </DialogDescription>
      </DialogHeader>
      <Input
        autoFocus
        aria-label={t("views.board.pinboard.nameLabel")}
        value={name}
        maxLength={60}
        onChange={e => setName(e.target.value)}
        className="my-4"
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("views.board.pinboard.cancel")}
        </Button>
        <Button type="submit" disabled={!ok || saving}>
          {mode === "create" ? t("views.board.pinboard.create") : t("views.board.pinboard.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
