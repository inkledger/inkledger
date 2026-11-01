import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { surface } from "@/components/app/surface";
import { cn } from "@/lib/utils";
import type { EvidenceSet } from "@contracts/workspace/flowMap";
import type { Scope } from "@contracts/workspace/model";
import { anchorLabel, areaLabel, periodLabel } from "@/lib/workspace/labels";
import { sketchFor, type SketchArea } from "@/lib/workspace/sketch";
import { t, type MessageKey } from "@/i18n";
import { PageSketch } from "./PageSketch";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

type LayoutRow = { anchorId: string; areaId: string; order: number; visible: boolean };

/** How much each block was used in a period: its controls' activations added up. */
function usesByAnchor(evidence: EvidenceSet): Map<string, number> {
  const uses = new Map<string, number>();
  for (const point of evidence.heat) uses.set(point.anchorId, (uses.get(point.anchorId) ?? 0) + point.activations);
  return uses;
}

/** Data colour in four steps of the theme's accent (no use: the muted fill), light enough for text in both themes. */
const STRENGTH = ["bg-primary/15", "bg-primary/25", "bg-primary/35", "bg-primary/45"] as const;
function strengthClass(count: number, most: number): string {
  if (count <= 0) return "bg-muted";
  return STRENGTH[Math.min(STRENGTH.length - 1, Math.floor((count / most) * STRENGTH.length))];
}

/** One period's page, drawn as the editor draws it; the stronger the tint, the more that block was used. */
function PeriodMap({ evidence, layout, scope }: { evidence: EvidenceSet; layout: readonly LayoutRow[] | null; scope: Scope }) {
  const period = periodLabel(evidence.coverage);
  const uses = usesByAnchor(evidence);
  const total = [...uses.values()].reduce((sum, value) => sum + value, 0);
  const most = Math.max(1, ...uses.values());
  const sketch = sketchFor(scope);
  const drawable = sketch && layout && layout.some(row => row.visible && sketch.areas.some(area => area.areaId === row.areaId && area.region !== "tray"));
  const renderArea = (area: SketchArea) => {
    if (area.region === "tray") return null;
    const blocks = (layout ?? []).filter(row => row.areaId === area.areaId && row.visible).sort((a, b) => a.order - b.order);
    if (blocks.length === 0) return null;
    return (
      <div className="grid gap-0.5">
        <p className="truncate text-2xs text-muted-foreground">{areaLabel(area.areaId)}</p>
        <ul className={area.axis === "column" ? "grid gap-0.5" : "flex flex-wrap gap-0.5"}>
          {blocks.map(block => {
            const count = uses.get(block.anchorId) ?? 0;
            const name = anchorLabel(block.anchorId);
            return (
              <li key={block.anchorId} title={t(key("timelineBlock"), { block: name, count })} className={cn("min-w-0 flex-1 truncate rounded-sm px-1.5 py-1 text-2xs text-foreground", strengthClass(count, most), count >= most && "font-medium")}>
                <span aria-hidden>{name}</span>
                <span className="sr-only">{t(key("timelineBlock"), { block: name, count })}</span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  };
  return (
    <figure {...surface("card")} className="flex w-64 shrink-0 flex-col gap-2 rounded-lg border bg-card p-3" aria-label={period} data-period={evidence.evidenceId}>
      {drawable ? <PageSketch sketch={sketch} renderArea={renderArea} dense /> : <p className="text-caption text-muted-foreground">{t(key("timelineUnavailable"))}</p>}
      <figcaption className="mt-auto flex items-baseline justify-between gap-2 text-caption">
        <span className="truncate font-medium tabular-nums">{period}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{t(key("timelineUses"), { count: total })}</span>
      </figcaption>
    </figure>
  );
}

/**
 * The page's use over time, shown at once: one map per period, oldest on the left, the newest
 * in view. Only this device's own evidence (imports are someone else's history), and only periods
 * with some use (an empty one has nothing to show).
 */
export function HeatTimeline({ evidence, layouts, scope }: {
  evidence: readonly EvidenceSet[];
  layouts: Readonly<Record<string, readonly LayoutRow[] | null>>;
  scope: Scope;
}) {
  const strip = useRef<HTMLUListElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const periods = evidence
    .filter(item => item.origin === "local" && item.coverage.lastAt > 0 && item.heat.some(point => point.activations > 0))
    .sort((a, b) => a.coverage.lastAt - b.coverage.lastAt)
    .slice(-12);
  const newest = periods.at(-1)?.evidenceId;
  const measure = () => {
    const element = strip.current;
    if (element) setEnds({ start: element.scrollLeft <= 1, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1 });
  };
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    element.scrollLeft = element.scrollWidth;
    measure();
  }, [newest]);
  const page = (direction: -1 | 1) => {
    const element = strip.current;
    const card = element?.querySelector("li");
    if (!element || !card) return;
    // One card (and its gap) at a time, whatever the density makes them measure.
    const step = card.getBoundingClientRect().width + parseFloat(getComputedStyle(element).columnGap || "0");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollBy({ left: direction * step, behavior: reduced ? "auto" : "smooth" });
  };
  return (
    <section aria-labelledby="workspace-heat-timeline" className="mt-4 grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 id="workspace-heat-timeline" className="text-body-sm font-medium">{t(key("timelineTitle"))}</h4>
          <p className="text-caption text-muted-foreground">{t(key("timelineHint"))}</p>
        </div>
        {periods.length > 1 && (
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={t(key("timelineOlder"))} disabled={ends.start} onClick={() => page(-1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={t(key("timelineNewer"))} disabled={ends.end} onClick={() => page(1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
      {periods.length === 0 ? (
        <p className="text-caption text-muted-foreground">{t(key("timelineEmpty"))}</p>
      ) : (
        <ul ref={strip} onScroll={measure} aria-label={t(key("timelineTitle"))} className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
          {periods.map(item => (
            <li key={item.evidenceId} className="flex snap-end">
              <PeriodMap evidence={item} layout={layouts[item.descriptor.effectiveRevision] ?? null} scope={scope} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
