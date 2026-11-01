import type { ReactNode } from "react";
import { surface } from "@/components/app/surface";
import { cn } from "@/lib/utils";
import type { Sketch, SketchArea, SketchRegion } from "@/lib/workspace/sketch";
import { t, type MessageKey } from "@/i18n";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

/**
 * A page drawn small, each area where the real page puts it: the Dashboard's header over its main column
 * and rail, the sidebar beside the page, a phone with its More sheet over the tab bar. What goes in an
 * area is the caller's (blocks to edit, or how much each block was used).
 */
export function PageSketch({ sketch, renderArea, dense = false }: { sketch: Sketch; renderArea: (area: SketchArea) => ReactNode; dense?: boolean }) {
  // An area the caller draws nothing for takes no room (a map of use has no pop-ups to show).
  const at = (region: SketchRegion) => sketch.areas.filter(area => area.region === region).flatMap(area => {
    const node = renderArea(area);
    return node === null || node === undefined || node === false ? [] : [<div key={area.areaId} className="min-w-0">{node}</div>];
  });
  const gap = dense ? "gap-1" : "gap-2";
  const tray = at("tray");
  const trayNode = tray.length > 0 && (
    <div className={cn("grid", gap)} data-sketch-region="tray">
      <p className="text-caption text-muted-foreground">{t(key("popups"))}</p>
      {tray}
    </div>
  );
  if (sketch.frame === "sidebar") {
    return (
      <div className={cn("grid", gap)}>
        <div {...surface("card")} className={cn("grid rounded-lg border bg-canvas p-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]", gap)}>
          <div className={cn("flex min-w-0 flex-col justify-between", gap)} data-sketch-region="sidebar">
            <div className={cn("grid", gap)}>{at("sidebar-top")}</div>
            <div className={cn("grid", gap)}>{at("sidebar-dock")}{at("sidebar-bottom")}</div>
          </div>
          {/* The page beside the sidebar, only for orientation: nothing to place there. */}
          <div aria-hidden className="hidden min-h-24 flex-col gap-2 p-3 sm:flex">
            <span className="text-caption text-muted-foreground">{t(key("pageBeside"))}</span>
            <span className="h-2 w-2/3 rounded-sm bg-muted" />
            <span className="h-2 w-1/2 rounded-sm bg-muted" />
            <span className="h-2 w-3/4 rounded-sm bg-muted" />
          </div>
        </div>
        {trayNode}
      </div>
    );
  }
  if (sketch.frame === "phone") {
    return (
      <div className={cn("grid", gap)}>
        <div {...surface("card")} className={cn("mx-auto grid w-full max-w-xs rounded-2xl border bg-canvas p-2", gap)}>
          <div className={cn("grid", gap)} data-sketch-region="sheet">{at("sheet")}</div>
          <div className="grid justify-items-end" data-sketch-region="edge">{at("edge")}</div>
          <div className="border-t pt-2" data-sketch-region="bar">{at("bar")}</div>
        </div>
        {trayNode}
      </div>
    );
  }
  const phone = sketch.frame === "phone-page";
  return (
    <div className={cn("grid", gap)}>
      <div {...surface("card")} className={cn("grid rounded-lg border bg-canvas p-2", gap, phone && "mx-auto w-full max-w-xs rounded-2xl")}>
        {at("top")}
        <div className={cn("grid", gap, !phone && "sm:grid-cols-[minmax(0,1fr)_minmax(0,0.42fr)]")}>
          <div className={cn("grid content-start", gap)}>{at("main")}</div>
          <div className={cn("grid content-start", gap)}>{at("rail")}</div>
        </div>
        {at("bottom")}
      </div>
      {trayNode}
    </div>
  );
}
