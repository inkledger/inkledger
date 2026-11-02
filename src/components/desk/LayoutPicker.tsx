import { LayoutPanelLeft } from "lucide-react";
import { PRESET_IDS, PRESETS, slotRects, type PresetId } from "@contracts/desk";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { layoutLabel } from "@/lib/desk/grid";
import { t } from "@/i18n";

/**
 * A small drawing of an arrangement: one block per slot, where it sits; `active` fills one
 * slot in the accent, and `targets` makes each slot a drop target of the snap bar.
 */
export function LayoutMiniature({ preset, active = null, targets = false, className }: { preset: PresetId; active?: number | null; targets?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("relative block h-7 w-10 shrink-0", className)}>
      {slotRects(preset).map((rect, slot) => (
        // surface: none — a block of a drawing, not a box on the page.
        <span
          key={slot}
          data-snap-preset={targets ? preset : undefined}
          data-snap-slot={targets ? slot : undefined}
          className={cn("absolute rounded-sm border", slot === active ? "border-primary-strong bg-primary" : "border-muted-foreground/40 bg-muted")}
          style={{
            left: `calc(${rect.x * 100}% + 1px)`,
            top: `calc(${rect.y * 100}% + 1px)`,
            width: `calc(${rect.w * 100}% - 2px)`,
            height: `calc(${rect.h * 100}% - 2px)`,
          }}
        />
      ))}
    </span>
  );
}

/**
 * "Layout": the arrangements with room for the `count` issues on the desk, drawn small (one
 * with more places keeps them as empty slots to open an issue in); the chosen one pressed.
 * `drawn` differs when the desk is too small for the chosen one (said below).
 */
export function LayoutPicker({ count, value, drawn, onChange }: { count: number; value: PresetId; drawn: PresetId; onChange: (id: PresetId) => void }) {
  const options = PRESET_IDS.filter(id => PRESETS[id].slots >= Math.max(count, 1));
  if (options.length < 2) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" title={t("pages.desk.layoutTitle")}>
          <LayoutPanelLeft className="h-4 w-4" aria-hidden />
          {t("pages.desk.layout")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto min-w-56 p-1.5">
        <div role="group" aria-label={t("pages.desk.layoutTitle")} className="grid gap-0.5">
          {options.map(id => (
            <button
              key={id}
              type="button"
              aria-pressed={id === value}
              onClick={() => onChange(id)}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-body-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                id === value && "bg-primary-soft text-primary-strong hover:bg-primary-soft"
              )}
            >
              <LayoutMiniature preset={id} className={cn(id === value && "[&>span]:border-primary-strong/50 [&>span]:bg-primary/30")} />
              <span className="min-w-0 truncate pr-2">{layoutLabel(id)}</span>
            </button>
          ))}
        </div>
        {drawn !== value && (
          <p className="mt-2 max-w-64 px-2 pb-1 text-caption text-muted-foreground [overflow-wrap:anywhere]">
            {t("pages.desk.narrowLayout", { layout: layoutLabel(drawn) })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
