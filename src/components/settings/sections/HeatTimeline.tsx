import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { surface } from "@/components/app/surface";
import { cn } from "@/lib/utils";
import type { EvidenceSet } from "@contracts/workspace/flowMap";
import type { Scope } from "@contracts/workspace/model";
import { anchorLabel, areaLabel, periodLabel } from "@/lib/workspace/labels";
import { heatClass, sketchFor, usesByAnchor, type SketchArea } from "@/lib/workspace/sketch";
import { t, type MessageKey } from "@/i18n";
import { AreaBlocks, PageSketch } from "./PageSketch";
import { prefersReducedMotion } from "@/lib/dom";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

type LayoutRow = { anchorId: string; areaId: string; order: number; visible: boolean };

/** One period's page, drawn as the editor draws it; the stronger the tint, the more that block was used. */
function PeriodMap({ evidence, layout, scope, live = false }: { evidence: EvidenceSet; layout: readonly LayoutRow[] | null; scope: Scope; live?: boolean }) {
  const period = live ? t(key("timelineLive")) : periodLabel(evidence.coverage);
  const uses = usesByAnchor(evidence.heat);
  const total = [...uses.values()].reduce((sum, value) => sum + value, 0);
  const most = Math.max(1, ...uses.values());
  const sketch = sketchFor(scope);
  const drawable = sketch && layout && layout.some(row => row.visible && sketch.areas.some(area => area.areaId === row.areaId && area.region !== "tray"));
  const sketchAreas = sketch?.areas ?? [];
  const nested = (areaId: string) => {
    const area = sketchAreas.find(item => item.areaId === areaId && item.region === "nested");
    return area ? renderArea(area) : null;
  };
  function renderArea(area: SketchArea): ReactNode {
    if (area.region === "tray" || !sketch) return null;
    const blocks = (layout ?? []).filter(row => row.areaId === area.areaId && row.visible).sort((a, b) => a.order - b.order);
    if (blocks.length === 0) return null;
    const tileFor = (anchorId: string) => {
      const count = uses.get(anchorId) ?? 0;
      const name = anchorLabel(anchorId);
      return (
        <div key={anchorId} title={t(key("timelineBlock"), { block: name, count })} className={cn("min-w-0 flex-1 truncate rounded-sm px-1.5 py-1 text-2xs text-foreground", heatClass(count, most), count >= most && "font-medium")}>
          <span aria-hidden>{name}</span>
          <span className="sr-only">{t(key("timelineBlock"), { block: name, count })}</span>
        </div>
      );
    };
    return (
      <div className="grid gap-0.5">
        <p className="truncate text-2xs text-muted-foreground">{areaLabel(area.areaId)}</p>
        <AreaBlocks area={area} sketch={sketch} anchorIds={blocks.map(block => block.anchorId)} tileFor={tileFor} nested={nested} dense />
      </div>
    );
  }
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
export function HeatTimeline({ evidence, live = null, layouts, scope }: {
  evidence: readonly EvidenceSet[];
  /** This week so far, worked out on the fly: shown last when no saved period is newer. */
  live?: EvidenceSet | null;
  layouts: Readonly<Record<string, readonly LayoutRow[] | null>>;
  scope: Scope;
}) {
  const strip = useRef<HTMLUListElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const periods = evidence
    .filter(item => item.origin === "local" && item.coverage.lastAt > 0 && item.heat.some(point => point.activations > 0))
    .sort((a, b) => a.coverage.lastAt - b.coverage.lastAt)
    .slice(-12);
  const now = live && live.heat.some(point => point.activations > 0) && (periods.at(-1)?.coverage.lastAt ?? 0) < live.coverage.lastAt ? live : null;
  const newest = now?.evidenceId ?? periods.at(-1)?.evidenceId;
  const count = periods.length + (now ? 1 : 0);
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
    element.scrollBy({ left: direction * step, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };
  return (
    <section aria-labelledby="workspace-heat-timeline" className="mt-4 grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 id="workspace-heat-timeline" className="text-body-sm font-medium">{t(key("timelineTitle"))}</h4>
          <p className="text-caption text-muted-foreground">{t(key("timelineHint"))}</p>
        </div>
        {count > 1 && (
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={t(key("timelineOlder"))} disabled={ends.start} onClick={() => page(-1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={t(key("timelineNewer"))} disabled={ends.end} onClick={() => page(1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
      {count === 0 ? (
        <p className="text-caption text-muted-foreground">{t(key("timelineEmpty"))}</p>
      ) : (
        <ul ref={strip} onScroll={measure} aria-label={t(key("timelineTitle"))} className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
          {periods.map(item => (
            <li key={item.evidenceId} className="flex snap-end">
              <PeriodMap evidence={item} layout={layouts[item.descriptor.effectiveRevision] ?? null} scope={scope} />
            </li>
          ))}
          {now && (
            <li key="live" className="flex snap-end">
              <PeriodMap evidence={now} layout={layouts[now.descriptor.effectiveRevision] ?? null} scope={scope} live />
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
