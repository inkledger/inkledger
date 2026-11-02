import { surface } from "@/components/app/surface";
import { cn } from "@/lib/utils";
import { heatClass, type HeatLayer } from "@/lib/workspace/sketch";
import { t, type MessageKey } from "@/i18n";
import { HitGrid } from "./HitGrid";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

/**
 * Use laid over a block of a page drawing: a tint by how much the block was used against the page's most
 * used one, and the dots of where in it the clicks landed. It sits under the block's own content (the
 * block must be `relative isolate`), so the drawing reads as "the page, with heat over it", names and
 * buttons as readable as ever. Nothing is laid over a block nobody used: the page stays flat there.
 */
export function HeatOverlay({ anchorId, layer }: { anchorId: string; layer: HeatLayer }) {
  const count = layer.uses.get(anchorId) ?? 0;
  if (count <= 0) return null;
  const cells = layer.grids.get(anchorId);
  return (
    <span aria-hidden data-heat className={cn("pointer-events-none absolute inset-0 -z-10 rounded-md", heatClass(count, layer.most), "p-1.5")}>
      {cells && <HitGrid cells={cells} most={layer.hitMost} />}
    </span>
  );
}

/** The count printed on one of the page's most used blocks (the others say it on hover and to screen readers). */
export function UseBadge({ anchorId, layer }: { anchorId: string; layer: HeatLayer }) {
  if (!layer.top.has(anchorId)) return null;
  return <span {...surface("chip")} aria-hidden data-use-badge className="shrink-0 rounded-sm border bg-card px-1 text-2xs tabular-nums text-foreground">{layer.uses.get(anchorId) ?? 0}</span>;
}

/** The use layer's key, one quiet line: few → many as the tint steps go, and what the dots mean. */
export function HeatLegend() {
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        {t(key("heatFew"))}
        <span aria-hidden className="flex gap-0.5">
          {[1, 2, 3, 4].map(step => <span key={step} className={cn("h-2.5 w-4 rounded-sm", heatClass(step, 4))} />)}
        </span>
        {t(key("heatMany"))}
      </span>
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary-strong opacity-70" />
        {t(key("heatDots"))}
      </span>
    </span>
  );
}
