import { useEffect, useRef, useState } from "react";
import {
  Check,
  Loader2,
  Maximize2,
  Scissors,
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
import { addCut, moveCut, segments, CUT_JUMP_MS, CUT_STEP_MS } from "@/lib/gapCuts";
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

  const [cuts, setCuts] = useState<number[]>([]);
  const [pieces, setPieces] = useState<Piece[]>([blank()]);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  /** A cut just added from the keyboard: it takes the focus once drawn. */
  const focusCut = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);

  const start = gap.start.getTime();
  const total = gap.seconds * 1000;
  const segs = segments(gap, cuts);
  const pct = (ms: number) => ((ms - start) / total) * 100;
  const msAt = (clientX: number) => {
    const r = strip.current?.getBoundingClientRect();
    if (!r || r.width === 0) return start;
    return start + ((clientX - r.left) / r.width) * total;
  };

  useEffect(() => {
    if (focusCut.current === null) return;
    strip.current
      ?.querySelector<HTMLButtonElement>(`[data-cut="${focusCut.current}"]`)
      ?.focus();
    focusCut.current = null;
  }, [cuts]);

  /**
   * A logged piece is fixed: moving one of its cuts or cutting it would change
   * a span Jira already has. Nothing moves while logging either.
   */
  const pieceLocked = (i: number) => saving || pieces[i]?.status === "done";
  const cutLocked = (k: number) => pieceLocked(k) || pieceLocked(k + 1);
  /** A new cut at `ms`, unless it falls in a locked piece. */
  const cutAt = (ms: number) => {
    const i = segs.findIndex(
      s => ms >= s.start.getTime() && ms < s.start.getTime() + s.seconds * 1000
    );
    return i < 0 || pieceLocked(i) ? cuts : addCut(gap, cuts, ms);
  };
  /** Mid the longest piece still open. */
  const cutOpenLongest = () => {
    const open = segs.filter((_, i) => !pieceLocked(i));
    if (open.length === 0) return cuts;
    const longest = open.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    return addCut(gap, cuts, longest.start.getTime() + (longest.seconds * 1000) / 2);
  };

  /** Apply new cuts, splitting / merging the pieces in step. */
  const applyCuts = (next: number[], focus = false) => {
    if (focus) {
      const added = next.find(c => !cuts.includes(c));
      if (added !== undefined) focusCut.current = added;
    }
    if (next.length > cuts.length) {
      const added = next.find(c => !cuts.includes(c));
      const k = added === undefined ? -1 : next.indexOf(added);
      if (k >= 0)
        setPieces(p => [
          ...p.slice(0, k + 1),
          { ...p[k], comment: "", status: "idle" },
          ...p.slice(k + 1),
        ]);
    }
    setCuts(next);
  };
  const removeCut = (k: number) => {
    if (cutLocked(k)) return;
    setCuts(c => c.filter((_, i) => i !== k));
    // The merged piece keeps the left issue, or the right one if the left had none.
    setPieces(p => [
      ...p.slice(0, k),
      p[k].issueKey ? p[k] : p[k + 1],
      ...p.slice(k + 2),
    ]);
  };
  const patch = (i: number, v: Partial<Piece>) =>
    setPieces(p => p.map((x, k) => (k === i ? { ...x, ...v } : x)));

  const pick = (apply: (pick: PickedIssue) => void, label: string) =>
    quickStart.pick(apply, label);

  const ready = pieces.filter((p, i) => p.issueKey && p.status !== "done" && segs[i]);
  const assigned = segs.reduce(
    (a, s, i) => a + (pieces[i]?.issueKey ? s.seconds : 0),
    0
  );

  const logAll = async () => {
    setSaving(true);
    let ok = 0;
    let failed = false;
    const done = new Set(segs.flatMap((_, i) => (pieces[i]?.status === "done" ? [i] : [])));
    for (let i = 0; i < segs.length; i++) {
      const p = pieces[i];
      if (!p?.issueKey || p.status === "done") continue;
      patch(i, { status: "saving" });
      try {
        await utils.client.worklogs.create.mutate({
          issueKey: p.issueKey,
          connectionId: p.connectionId,
          // Whole minutes (Jira's unit), rounded, never under one: a piece
          // may touch its neighbour by < 30s, within the overlap tolerance.
          seconds: Math.max(60, Math.round(segs[i].seconds / 60) * 60),
          started: segs[i].start.toISOString(),
          comment: p.comment.trim(),
          fromTimer: false,
        });
        ok++;
        done.add(i);
        patch(i, { status: "done" });
      } catch (e) {
        failed = true;
        patch(i, { status: "error" });
        toast.error(
          `${p.issueKey}: ${e instanceof Error ? e.message : String(e)}`
        );
        break; // stop: what is left stays here to retry
      }
    }
    setSaving(false);
    invalidate();
    if (ok > 0) {
      toast.success(
        t("views.dashboard.gap.created", { count: ok })
      );
    }
    // Whole hole logged: close. Pieces left without an issue stay to finish later.
    if (!failed && segs.every((_, i) => done.has(i))) onDone();
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={e => {
        const el = e.target as HTMLElement;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
        if (e.key === "c" || e.key === "C") {
          e.preventDefault();
          // At the pointer when it is on the strip, else mid longest piece.
          applyCuts(hover !== null ? cutAt(hover) : cutOpenLongest(), true);
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
        {/* The strip: click to cut, drag the handles, colours = projects. */}
        <div
          ref={strip}
          role="group"
          // Focusable: a click leaves the focus here (WebKit never focuses a
          // clicked button), so "C" still reaches the handler above.
          tabIndex={-1}
          aria-label={t("views.dashboard.gap.stripLabel")}
          className="relative h-16 cursor-crosshair select-none rounded-lg bg-muted outline-none"
          onPointerMove={e => {
            if (drag.current !== null) {
              const k = drag.current;
              if (!cutLocked(k)) setCuts(c => moveCut(gap, c, k, msAt(e.clientX)));
            } else setHover(msAt(e.clientX));
          }}
          onPointerLeave={() => setHover(null)}
          onPointerUp={() => (drag.current = null)}
          onClick={e => {
            if (drag.current === null) applyCuts(cutAt(msAt(e.clientX)));
          }}
        >
          {segs.map((s, i) => {
            const key = pieces[i]?.issueKey;
            const color = key ? projectColor(projectOf(key)) : null;
            return (
              <div
                key={s.start.getTime()}
                className={cn(
                  "absolute inset-y-1 flex items-center justify-center overflow-hidden rounded-md px-1 text-caption font-medium",
                  color
                    ? color.soft
                    : "border-2 border-dashed border-primary-strong/35 bg-primary-soft/50 text-primary-strong",
                  pieces[i]?.status === "done" && "opacity-50"
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
          {hover !== null && !dragging && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40"
              style={{ left: `${pct(Math.round(hover / CUT_STEP_MS) * CUT_STEP_MS)}%` }}
            />
          )}
          {cuts.map((c, k) => (
            <button
              key={k}
              type="button"
              data-cut={c}
              aria-label={
                cutLocked(k)
                  ? t("views.dashboard.gap.cutLocked", { time: clock().format(c) })
                  : t("views.dashboard.gap.cutLabel", { time: clock().format(c) })
              }
              aria-disabled={cutLocked(k) || undefined}
              className="absolute -inset-y-1.5 z-10 flex w-4 -translate-x-1/2 cursor-ew-resize touch-none aria-disabled:cursor-default justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              style={{ left: `${pct(c)}%` }}
              onClick={e => e.stopPropagation()}
              onPointerDown={e => {
                e.stopPropagation();
                if (cutLocked(k)) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = k;
                setDragging(true);
              }}
              onPointerUp={e => {
                e.currentTarget.releasePointerCapture(e.pointerId);
                setDragging(false);
                // Let the click that follows know it was a drag.
                setTimeout(() => (drag.current = null), 0);
              }}
              onKeyDown={e => {
                if (cutLocked(k)) return;
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const step = e.shiftKey ? CUT_JUMP_MS : CUT_STEP_MS;
                  const d = e.key === "ArrowLeft" ? -step : step;
                  setCuts(cs => moveCut(gap, cs, k, cs[k] + d));
                } else if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  removeCut(k);
                }
              }}
            >
              <span className="h-full w-0.5 rounded-full bg-foreground" />
            </button>
          ))}
        </div>
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
              disabled={saving || segs.every((_, i) => pieceLocked(i))}
              onClick={() => applyCuts(cutOpenLongest(), true)}
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
                      setPieces(p =>
                        p.map(x => (x.status === "done" ? x : { ...x, issueKey: key, connectionId }))
                      ),
                    t("views.dashboard.gap.assignAllPrompt")
                  )
                }
              >
                {t("views.dashboard.gap.allOnOne")}
              </Button>
            )}
          </span>
        </div>
        <ul className="mt-2 grid gap-2">
          {segs.map((s, i) => {
            const p = pieces[i] ?? blank();
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
                    {segs.length === 1 && p.issueKey && p.status !== "done" && (
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
                    {i < cuts.length && !cutLocked(i) && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("views.dashboard.gap.mergeNext")}
                        title={t("views.dashboard.gap.merge")}
                        onClick={() => removeCut(i)}
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
                      ({ key, connectionId }) => patch(i, { issueKey: key, connectionId, status: "idle" }),
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
                  ) : (
                    t("views.dashboard.gap.chooseIssue")
                  )}
                </button>
                {p.issueKey && p.status !== "done" && (
                  <Input
                    value={p.comment}
                    onChange={e => patch(i, { comment: e.target.value })}
                    placeholder={t("views.dashboard.gap.commentPlaceholder")}
                    aria-label={t("views.dashboard.gap.commentFor", { from: clock().format(s.start), to: clock().format(endOf(s)) })}
                    className="h-8"
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t px-5 py-4">
        <span className="text-body-sm text-muted-foreground">
          {t("views.dashboard.gap.assigned")}{" "}
          <span className="font-semibold text-foreground tabular">
            {formatDuration(assigned)}
          </span>{" "}
          {t("views.dashboard.gap.assignedOf", { duration: formatDuration(gap.seconds) })}
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
