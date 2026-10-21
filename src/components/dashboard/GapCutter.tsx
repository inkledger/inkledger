import { useEffect, useRef, useState } from "react";
import {
  Check,
  Loader2,
  Maximize2,
  Rows2,
  Scissors,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  formatDuration,
  formatDurationLong,
  type TimeSpan,
} from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { quickStart, type PickedIssue } from "@/lib/quickStart";
import { timerLog } from "@/lib/timerLog";
import { realSeconds } from "@contracts/placement";
import { addCut, moveCut, segments, takenSpans, withCuts, withoutCut, CUT_JUMP_MS, CUT_STEP_MS, type Lane } from "@/lib/gapCuts";
import { projectColor, projectOf } from "@/lib/projectColors";
import { useInvalidateWorklogs } from "@/hooks/useInvalidateWorklogs";
import { Kbd } from "@/components/app/Kbd";
import { SectionLabel } from "@/components/app/PageHeader";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { t, dateFormat } from "@/i18n";

const clock = () => dateFormat({ hour: "2-digit", minute: "2-digit" });

type Piece = {
  issueKey: string | null;
  connectionId?: number;
  comment: string;
  status: "idle" | "saving" | "done" | "error";
};

const blank = (): Piece => ({ issueKey: null, comment: "", status: "idle" });
const endOf = (s: TimeSpan) => new Date(s.start.getTime() + s.seconds * 1000);

/**
 * "Montaggio": a hole of the working day as a strip that can be cut, like a
 * video timeline; every piece gets a Jira issue and is logged at its time.
 * Work done at the same time (two systems at once) goes on lanes under it:
 * any span of the hole, overlapping others, logged on its own issue; the
 * hours worked count once (their union), never twice.
 */
export function GapCutter({
  gap,
  onOpenChange,
}: {
  gap: TimeSpan | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={gap !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 bg-canvas p-0 sm:max-w-lg"
      >
        {gap && (
          <GapCutterBody
            key={gap.start.getTime()}
            gap={gap}
            onDone={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function GapCutterBody({ gap, onDone }: { gap: TimeSpan; onDone: () => void }) {
  const utils = trpc.useUtils();
  const invalidate = useInvalidateWorklogs();
  const issues = trpc.issues.all.useQuery(undefined, { staleTime: 60_000 });
  const summaryOf = (piece: { issueKey: string | null; connectionId?: number | null }) =>
    issues.data?.find(i => i.key === piece.issueKey && (piece.connectionId == null || i.connectionId === piece.connectionId))?.summary;

  /** Lane 0 is the hole itself; the others, work done at the same time. */
  const [lanes, setLanes] = useState<Lane<Piece>[]>([{ cuts: [], pieces: [blank()] }]);
  /** Where the pointer is on a strip (its lane and time). */
  const [hover, setHover] = useState<{ lane: number; ms: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** A cut just added from the keyboard: it takes the focus once drawn. */
  const focusCut = useRef<{ lane: number; at: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const strips = useRef<(HTMLDivElement | null)[]>([]);
  const drag = useRef<{ lane: number; k: number } | null>(null);

  const start = gap.start.getTime();
  const total = gap.seconds * 1000;
  const segsOf = (li: number) => segments(gap, lanes[li]?.cuts ?? []);
  const segs = segsOf(0);
  const pct = (ms: number) => ((ms - start) / total) * 100;
  const msAt = (li: number, clientX: number) => {
    const r = strips.current[li]?.getBoundingClientRect();
    if (!r || r.width === 0) return start;
    return start + ((clientX - r.left) / r.width) * total;
  };

  useEffect(() => {
    const f = focusCut.current;
    if (f === null) return;
    strips.current[f.lane]
      ?.querySelector<HTMLButtonElement>(`[data-cut="${f.at}"]`)
      ?.focus();
    focusCut.current = null;
  }, [lanes]);

  /**
   * A logged piece is fixed: moving one of its cuts or cutting it would change
   * a span Jira already has. Nothing moves while logging either.
   */
  const pieceLocked = (li: number, i: number) => saving || lanes[li]?.pieces[i]?.status === "done";
  const cutLocked = (li: number, k: number) => pieceLocked(li, k) || pieceLocked(li, k + 1);
  /** A new cut at `ms`, unless it falls in a locked piece. */
  const cutAt = (li: number, ms: number) => {
    const cuts = lanes[li].cuts;
    const i = segsOf(li).findIndex(
      s => ms >= s.start.getTime() && ms < s.start.getTime() + s.seconds * 1000
    );
    return i < 0 || pieceLocked(li, i) ? cuts : addCut(gap, cuts, ms);
  };
  /** Mid the longest piece still open. */
  const cutOpenLongest = (li: number) => {
    const cuts = lanes[li].cuts;
    const open = segsOf(li).filter((_, i) => !pieceLocked(li, i));
    if (open.length === 0) return cuts;
    const longest = open.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    return addCut(gap, cuts, longest.start.getTime() + (longest.seconds * 1000) / 2);
  };

  const setLane = (li: number, f: (l: Lane<Piece>) => Lane<Piece>) =>
    setLanes(ls => ls.map((l, j) => (j === li ? f(l) : l)));
  /** Apply new cuts, splitting / merging the pieces in step. */
  const applyCuts = (li: number, next: number[], focus = false) => {
    if (focus) {
      const added = next.find(c => !lanes[li].cuts.includes(c));
      if (added !== undefined) focusCut.current = { lane: li, at: added };
    }
    setLane(li, l => withCuts(l, next, p => ({ ...p, comment: "", status: "idle" })));
  };
  const removeCut = (li: number, k: number) => {
    if (cutLocked(li, k)) return;
    // The merged piece keeps the left issue, or the right one if the left had none.
    setLane(li, l => withoutCut(l, k, p => !!p.issueKey));
  };
  const patch = (li: number, i: number, v: Partial<Piece>) =>
    setLane(li, l => ({ ...l, pieces: l.pieces.map((x, k) => (k === i ? { ...x, ...v } : x)) }));
  const addLane = () => setLanes(ls => [...ls, { cuts: [], pieces: [blank()] }]);
  const laneRemovable = (li: number) => li > 0 && !saving && !lanes[li].pieces.some(p => p.status === "done");
  const removeLane = (li: number) => {
    if (!laneRemovable(li)) return;
    setHover(null);
    setLanes(ls => ls.filter((_, j) => j !== li));
  };

  const pick = (apply: (pick: PickedIssue) => void, label: string) =>
    quickStart.pick(apply, label);

  const ready = lanes.flatMap((l, li) =>
    l.pieces.filter((p, i) => p.issueKey && p.status !== "done" && segsOf(li)[i])
  );
  // The hours the hole gets: alone, its assigned pieces; with lanes, their union (parallel work counts once).
  const assigned =
    lanes.length === 1
      ? segs.reduce((a, s, i) => a + (lanes[0].pieces[i]?.issueKey ? s.seconds : 0), 0)
      : realSeconds(takenSpans(gap, lanes, p => !!p.issueKey));

  const logAll = async () => {
    setSaving(true);
    let ok = 0;
    let failed = false;
    const done = new Set(
      lanes.flatMap((l, li) => l.pieces.flatMap((p, i) => (p.status === "done" ? [`${li}:${i}`] : [])))
    );
    run: for (let li = 0; li < lanes.length; li++) {
      const laneSegs = segsOf(li);
      for (let i = 0; i < laneSegs.length; i++) {
        const p = lanes[li].pieces[i];
        if (!p?.issueKey || p.status === "done") continue;
        patch(li, i, { status: "saving" });
        try {
          await utils.client.worklogs.create.mutate({
            issueKey: p.issueKey,
            connectionId: p.connectionId,
            // Whole minutes (Jira's unit), rounded, never under one: a piece
            // may touch its neighbour by < 30s, within the overlap tolerance.
            seconds: Math.max(60, Math.round(laneSegs[i].seconds / 60) * 60),
            started: laneSegs[i].start.toISOString(),
            comment: p.comment.trim(),
            fromTimer: false,
          });
          ok++;
          done.add(`${li}:${i}`);
          patch(li, i, { status: "done" });
        } catch (e) {
          failed = true;
          patch(li, i, { status: "error" });
          toast.error(
            `${p.issueKey}: ${e instanceof Error ? e.message : String(e)}`
          );
          break run; // stop: what is left stays here to retry
        }
      }
    }
    setSaving(false);
    invalidate();
    if (ok > 0) {
      toast.success(
        t("views.dashboard.gap.created", { count: ok })
      );
    }
    // Whole hole logged: close. Pieces left without an issue stay to finish later;
    // an empty piece of a parallel lane is simply not logged.
    const holeDone = segs.every((_, i) => done.has(`0:${i}`));
    const lanesDone = lanes.every((l, li) => li === 0 || l.pieces.every((p, i) => !p.issueKey || done.has(`${li}:${i}`)));
    if (!failed && holeDone && lanesDone) onDone();
  };

  const renderStrip = (li: number) => {
    const lane = lanes[li];
    const laneSegs = segsOf(li);
    const parallel = li > 0;
    return (
      <div
        key={li}
        ref={el => {
          strips.current[li] = el;
        }}
        role="group"
        data-lane={parallel ? li : undefined}
        // Focusable: a click leaves the focus here (WebKit never focuses a
        // clicked button), so "C" still reaches the handler above.
        tabIndex={-1}
        aria-label={parallel ? t("views.dashboard.gap.laneLabel", { n: li + 1 }) : t("views.dashboard.gap.stripLabel")}
        className={cn(
          "relative cursor-crosshair select-none rounded-lg bg-muted outline-none",
          parallel ? "mt-1.5 h-12" : "h-16"
        )}
        onPointerMove={e => {
          const d = drag.current;
          if (d !== null) {
            if (d.lane === li && !cutLocked(li, d.k)) setLane(li, l => ({ ...l, cuts: moveCut(gap, l.cuts, d.k, msAt(li, e.clientX)) }));
          } else setHover({ lane: li, ms: msAt(li, e.clientX) });
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={() => (drag.current = null)}
        onClick={e => {
          if (drag.current === null) applyCuts(li, cutAt(li, msAt(li, e.clientX)));
        }}
      >
        {laneSegs.map((s, i) => {
          const key = lane.pieces[i]?.issueKey;
          const color = key ? projectColor(projectOf(key)) : null;
          return (
            <div
              key={s.start.getTime()}
              className={cn(
                "absolute inset-y-1 flex items-center justify-center overflow-hidden rounded-md px-1 text-caption font-medium",
                color
                  ? color.soft
                  : parallel
                    ? "border border-dashed border-muted-foreground/40 text-muted-foreground"
                    : "border-2 border-dashed border-primary-strong/35 bg-primary-soft/50 text-primary-strong",
                lane.pieces[i]?.status === "done" && "opacity-50"
              )}
              style={{
                left: `calc(${pct(s.start.getTime())}% + 2px)`,
                width: `calc(${(s.seconds * 1000 * 100) / total}% - 4px)`,
              }}
            >
              {color && (
                <span
                  className={cn("absolute inset-y-0 left-0 w-1.5", color.fill)}
                />
              )}
              <span className="truncate">
                {key ?? formatDuration(s.seconds)}
              </span>
            </div>
          );
        })}
        {hover !== null && hover.lane === li && !dragging && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40"
            style={{ left: `${pct(Math.round(hover.ms / CUT_STEP_MS) * CUT_STEP_MS)}%` }}
          />
        )}
        {lane.cuts.map((c, k) => (
          <button
            key={k}
            type="button"
            data-cut={c}
            aria-label={
              cutLocked(li, k)
                ? t("views.dashboard.gap.cutLocked", { time: clock().format(c) })
                : t("views.dashboard.gap.cutLabel", { time: clock().format(c) })
            }
            aria-disabled={cutLocked(li, k) || undefined}
            className="absolute -inset-y-1.5 z-10 flex w-4 -translate-x-1/2 cursor-ew-resize touch-none aria-disabled:cursor-default justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            style={{ left: `${pct(c)}%` }}
            onClick={e => e.stopPropagation()}
            onPointerDown={e => {
              e.stopPropagation();
              if (cutLocked(li, k)) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { lane: li, k };
              setDragging(true);
            }}
            onPointerUp={e => {
              e.currentTarget.releasePointerCapture(e.pointerId);
              setDragging(false);
              // Let the click that follows know it was a drag.
              setTimeout(() => (drag.current = null), 0);
            }}
            onKeyDown={e => {
              if (cutLocked(li, k)) return;
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const step = e.shiftKey ? CUT_JUMP_MS : CUT_STEP_MS;
                const d = e.key === "ArrowLeft" ? -step : step;
                setLane(li, l => ({ ...l, cuts: moveCut(gap, l.cuts, k, l.cuts[k] + d) }));
              } else if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                removeCut(li, k);
              }
            }}
          >
            <span className="h-full w-0.5 rounded-full bg-foreground" />
          </button>
        ))}
      </div>
    );
  };

  const renderPiece = (li: number, s: TimeSpan, i: number) => {
    const p = lanes[li].pieces[i] ?? blank();
    const laneCuts = lanes[li].cuts;
    return (
      <li
        key={s.start.getTime()}
        className="grid gap-2 rounded-lg border bg-card p-3"
      >
        <div className="flex items-center gap-2">
          <span className="text-body-sm tabular">
            {clock().format(s.start)}–{clock().format(endOf(s))}
          </span>
          <span className="text-body-sm text-muted-foreground tabular">
            {formatDuration(s.seconds)}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {p.status === "saving" && (
              <Loader2
                className="h-4 w-4 text-muted-foreground motion-safe:animate-spin"
                aria-label={t("views.dashboard.gap.logging")}
              />
            )}
            {p.status === "done" && (
              <Check className="h-4 w-4 text-primary-strong" aria-label={t("views.dashboard.gap.logged")} />
            )}
            {p.status === "error" && (
              <TriangleAlert className="h-4 w-4 text-danger" aria-label={t("views.dashboard.gap.notLogged")} />
            )}
            {lanes.length === 1 && segs.length === 1 && p.issueKey && p.status !== "done" && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("views.dashboard.gap.openDialog")}
                title={t("views.dashboard.gap.openDialogHint")}
                onClick={() => {
                  timerLog.push({
                    issueKey: p.issueKey!,
                    connectionId: p.connectionId,
                    seconds: Math.max(60, Math.round(s.seconds / 60) * 60),
                    note: p.comment,
                    fromTimer: false,
                    start: s.start,
                  });
                  onDone();
                }}
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {li > 0 && p.issueKey && p.status !== "done" && !saving && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("views.dashboard.gap.emptyPiece", { from: clock().format(s.start), to: clock().format(endOf(s)) })}
                title={t("views.dashboard.gap.emptyPieceHint")}
                onClick={() => patch(li, i, { issueKey: null, connectionId: undefined, comment: "", status: "idle" })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {i < laneCuts.length && !cutLocked(li, i) && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("views.dashboard.gap.mergeNext")}
                title={t("views.dashboard.gap.merge")}
                onClick={() => removeCut(li, i)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </span>
        </div>
        <button
          type="button"
          disabled={p.status === "done" || saving}
          onClick={() =>
            pick(
              ({ key, connectionId }) => patch(li, i, { issueKey: key, connectionId, status: "idle" }),
              t("views.dashboard.gap.logOnPrompt", { from: clock().format(s.start), to: clock().format(endOf(s)) })
            )
          }
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left text-body-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60",
            !p.issueKey && "border-dashed text-muted-foreground"
          )}
        >
          {p.issueKey ? (
            <>
              <ProjectAvatar project={projectOf(p.issueKey)} size="xs" />
              <span className="shrink-0 font-semibold">{p.issueKey}</span>
              <span className="truncate text-muted-foreground">
                {summaryOf(p)}
              </span>
            </>
          ) : li > 0 ? (
            t("views.dashboard.gap.chooseIssueParallel")
          ) : (
            t("views.dashboard.gap.chooseIssue")
          )}
        </button>
        {p.issueKey && p.status !== "done" && (
          <Input
            value={p.comment}
            onChange={e => patch(li, i, { comment: e.target.value })}
            placeholder={t("views.dashboard.gap.commentPlaceholder")}
            aria-label={t("views.dashboard.gap.commentFor", { from: clock().format(s.start), to: clock().format(endOf(s)) })}
            className="h-8"
          />
        )}
      </li>
    );
  };

  /** The lane "C" acts on: the one under the pointer, else the one holding the focus, else the hole. */
  const laneOf = (el: HTMLElement) => {
    const at = strips.current.findIndex(s => !!s && s.contains(el));
    return at < 0 ? 0 : at;
  };
  const parallelSeconds = lanes.length > 1 ? takenSpans(gap, lanes, p => !!p.issueKey).reduce((a, s) => a + s.seconds, 0) - assigned : 0;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={e => {
        const el = e.target as HTMLElement;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
        if (e.key === "c" || e.key === "C") {
          e.preventDefault();
          // At the pointer when it is on a strip, else mid longest piece.
          if (hover !== null) applyCuts(hover.lane, cutAt(hover.lane, hover.ms), true);
          else {
            const li = laneOf(el);
            applyCuts(li, cutOpenLongest(li), true);
          }
        }
      }}
    >
      <div className="border-b px-5 py-4 pr-12">
        <SheetTitle className="font-display text-heading">
          {t("views.dashboard.gap.title")}
        </SheetTitle>
        <SheetDescription className="text-caption text-muted-foreground">
          {t("views.dashboard.gap.description", { from: clock().format(gap.start), to: clock().format(endOf(gap)), duration: formatDurationLong(gap.seconds) })}
        </SheetDescription>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {/* The strip: click to cut, drag the handles, colours = projects; lanes under it for parallel work. */}
        {lanes.map((_, li) => renderStrip(li))}
        <div className="mt-1.5 flex justify-between text-caption text-muted-foreground tabular">
          <span>{clock().format(gap.start)}</span>
          <span className="max-sm:hidden">
            <Kbd>C</Kbd>{t("views.dashboard.gap.hintCut")}<Kbd>←</Kbd>
            <Kbd>→</Kbd>{t("views.dashboard.gap.hintStep")}<Kbd>⇧</Kbd>{t("views.dashboard.gap.hintShift")}
          </span>
          <span>{clock().format(endOf(gap))}</span>
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <SectionLabel as="h3" className="px-0">
            {t("views.dashboard.gap.pieces", { count: segs.length })}
          </SectionLabel>
          <span className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={saving || segs.every((_, i) => pieceLocked(0, i))}
              onClick={() => applyCuts(0, cutOpenLongest(0), true)}
            >
              <Scissors className="h-3.5 w-3.5" />
              {t("views.dashboard.gap.cut")}
            </Button>
            {segs.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  pick(
                    ({ key, connectionId }) =>
                      setLane(0, l => ({
                        ...l,
                        pieces: l.pieces.map(x => (x.status === "done" ? x : { ...x, issueKey: key, connectionId })),
                      })),
                    t("views.dashboard.gap.assignAllPrompt")
                  )
                }
              >
                {t("views.dashboard.gap.allOnOne")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              title={t("views.dashboard.gap.addLaneHint")}
              onClick={addLane}
            >
              <Rows2 className="h-3.5 w-3.5" />
              {t("views.dashboard.gap.addLane")}
            </Button>
          </span>
        </div>
        <ul className="mt-2 grid gap-2">
          {segs.map((s, i) => renderPiece(0, s, i))}
        </ul>
        {lanes.slice(1).map((_, j) => {
          const li = j + 1;
          return (
            <section key={li} aria-label={t("views.dashboard.gap.laneLabel", { n: li + 1 })} className="mt-5">
              <div className="flex items-center justify-between gap-2">
                <SectionLabel as="h3" className="px-0">
                  {t("views.dashboard.gap.laneTitle", { n: li + 1 })}
                </SectionLabel>
                {laneRemovable(li) && (
                  <Button variant="ghost" size="sm" onClick={() => removeLane(li)}>
                    <X className="h-3.5 w-3.5" />
                    {t("views.dashboard.gap.removeLane")}
                  </Button>
                )}
              </div>
              <ul className="mt-2 grid gap-2">
                {segsOf(li).map((s, i) => renderPiece(li, s, i))}
              </ul>
            </section>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t px-5 py-4">
        <span className="text-body-sm text-muted-foreground">
          {t("views.dashboard.gap.assigned")}{" "}
          <span className="font-semibold text-foreground tabular">
            {formatDuration(assigned)}
          </span>{" "}
          {t("views.dashboard.gap.assignedOf", { duration: formatDuration(gap.seconds) })}
          {parallelSeconds > 0 && (
            <> · {t("views.dashboard.gap.parallel", { duration: formatDuration(parallelSeconds) })}</>
          )}
        </span>
        <Button
          className="ml-auto"
          disabled={ready.length === 0 || saving}
          onClick={() => void logAll()}
        >
          {saving && <Loader2 className="h-4 w-4 motion-safe:animate-spin" />}
          {ready.length <= 1
            ? t("views.dashboard.gap.log")
            : t("views.dashboard.gap.logMany", { count: ready.length })}
        </Button>
      </div>
    </div>
  );
}
