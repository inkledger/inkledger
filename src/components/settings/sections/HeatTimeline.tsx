import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { surface } from "@/components/app/surface";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import type { EvidenceSet } from "@contracts/workspace/flowMap";
import type { SurfaceId } from "@contracts/workspace/model";
import { anchorLabel, areaLabel, inPageOrder } from "@/lib/workspace/labels";
import { dateFormat, t, type MessageKey } from "@/i18n";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

type LayoutRow = { anchorId: string; areaId: string; order: number; visible: boolean };

/** How much each block was used in a period: its controls' activations added up. */
function usesByAnchor(evidence: EvidenceSet): Map<string, number> {
  const uses = new Map<string, number>();
  for (const point of evidence.heat) uses.set(point.anchorId, (uses.get(point.anchorId) ?? 0) + point.activations);
  return uses;
}

/** One period's page, drawn as its areas and blocks; the stronger the tint, the more that block was used. */
function PeriodMap({ evidence, layout, surfaceId }: { evidence: EvidenceSet; layout: readonly LayoutRow[] | null; surfaceId: SurfaceId }) {
  const day = dateFormat({ day: "numeric", month: "short" });
  const period = `${day.format(evidence.coverage.firstAt)} – ${day.format(evidence.coverage.lastAt)}`;
  const uses = usesByAnchor(evidence);
  const total = [...uses.values()].reduce((sum, value) => sum + value, 0);
  const most = Math.max(1, ...uses.values());
  const areas = inPageOrder(CATALOG_V1.areas.filter(area => area.surfaceId === surfaceId && area.role !== "overlay"));
  return (
    <figure {...surface("card")} className="flex w-64 shrink-0 flex-col gap-2 rounded-lg border bg-card p-3" aria-label={period} data-period={evidence.evidenceId}>
      {layout ? (
        <div className="grid gap-2">
          {areas.map(area => {
            const blocks = layout.filter(row => row.areaId === area.id && row.visible).sort((a, b) => a.order - b.order);
            if (blocks.length === 0) return null;
            return (
              <div key={area.id} className="grid gap-1">
                <p className="truncate text-2xs text-muted-foreground">{areaLabel(area.id)}</p>
                <ul className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(blocks.length, 3)}, minmax(0, 1fr))` }}>
                  {blocks.map(block => {
                    const count = uses.get(block.anchorId) ?? 0;
                    const strength = count / most;
                    const name = anchorLabel(block.anchorId);
                    return (
                      <li
                        key={block.anchorId}
                        title={t(key("timelineBlock"), { block: name, count })}
                        className={`min-w-0 truncate rounded-sm px-1.5 py-1 text-2xs text-foreground ${strength > 0.66 ? "font-medium" : ""}`}
                        // Data colour: the theme's accent, as strong as the use (no use: the muted fill). Capped so
                        // the foreground text stays readable on it in both themes.
                        style={{ backgroundColor: count > 0 ? `hsl(var(--primary) / ${(0.12 + strength * 0.5).toFixed(2)})` : "hsl(var(--muted))" }}
                      >
                        <span aria-hidden>{name}</span>
                        <span className="sr-only">{t(key("timelineBlock"), { block: name, count })}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-caption text-muted-foreground">{t(key("timelineUnavailable"))}</p>
      )}
      <figcaption className="mt-auto flex items-baseline justify-between gap-2 text-caption">
        <span className="truncate font-medium tabular-nums">{period}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{t(key("timelineUses"), { count: total })}</span>
      </figcaption>
    </figure>
  );
}

/**
 * The page's use over time, shown at once: one map per period, oldest on the left, the newest
 * in view. Only this device's own evidence (imports are someone else's history).
 */
export function HeatTimeline({ evidence, layouts, surfaceId }: {
  evidence: readonly EvidenceSet[];
  layouts: Readonly<Record<string, readonly LayoutRow[] | null>>;
  surfaceId: SurfaceId;
}) {
  const strip = useRef<HTMLUListElement>(null);
  const periods = evidence.filter(item => item.origin === "local").sort((a, b) => a.coverage.lastAt - b.coverage.lastAt).slice(-12);
  const newest = periods.at(-1)?.evidenceId;
  useEffect(() => {
    const element = strip.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [newest]);
  const page = (direction: -1 | 1) => strip.current?.scrollBy({ left: direction * 272, behavior: "smooth" });
  return (
    <section aria-labelledby="workspace-heat-timeline" className="mt-4 grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h4 id="workspace-heat-timeline" className="text-body-sm font-medium">{t(key("timelineTitle"))}</h4>
          <p className="text-caption text-muted-foreground">{t(key("timelineHint"))}</p>
        </div>
        {periods.length > 1 && (
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={t(key("timelineOlder"))} onClick={() => page(-1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={t(key("timelineNewer"))} onClick={() => page(1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
      {periods.length === 0 ? (
        <p className="text-caption text-muted-foreground">{t(key("timelineEmpty"))}</p>
      ) : (
        <ul ref={strip} aria-label={t(key("timelineTitle"))} className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
          {periods.map(item => (
            <li key={item.evidenceId} className="flex snap-end">
              <PeriodMap evidence={item} layout={layouts[item.descriptor.effectiveRevision] ?? null} surfaceId={surfaceId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
