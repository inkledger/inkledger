import { Fragment, useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { surface } from "@/components/app/surface";
import { cn } from "@/lib/utils";
import { dashboardSegments, sidebarActionSegments, type Sketch, type SketchArea, type SketchAxis, type SketchRegion } from "@/lib/workspace/sketch";
import { t, type MessageKey } from "@/i18n";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

/**
 * A page drawn small, each area where the real page puts it: the Dashboard's header over its main column
 * and rail, the sidebar beside the page, a phone with its More sheet over the tab bar. What goes in an
 * area is the caller's (blocks to edit, or how much each block was used).
 */
export function PageSketch({ sketch, renderArea }: { sketch: Sketch; renderArea: (area: SketchArea) => ReactNode }) {
  // An area the caller draws nothing for takes no room (a map of use has no pop-ups to show).
  const at = (region: SketchRegion) => sketch.areas.filter(area => area.region === region).flatMap(area => {
    const node = renderArea(area);
    return node === null || node === undefined || node === false ? [] : [<div key={area.areaId} className="min-w-0">{node}</div>];
  });
  const gap = "gap-2";
  const trayNode = <Tray areas={sketch.areas.filter(area => area.region === "tray")} draw={at} />;
  if (sketch.frame === "sidebar") {
    return (
      <div className={cn("grid", gap)}>
        <div {...surface("card")} className={cn("grid rounded-lg border bg-canvas p-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]", gap)}>
          <div className={cn("flex min-w-0 flex-col justify-between", gap)} data-sketch-region="sidebar">
            <div className={cn("grid", gap)}>{at("sidebar-top")}</div>
            <div className={cn("grid", gap)}>{at("sidebar-bottom")}</div>
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
        {/* The page's title on the left, only for orientation; the header's controls stand beside it, as on the page. */}
        <div className={cn("grid items-start", gap, !phone && "sm:grid-cols-[minmax(0,0.5fr)_minmax(0,1.5fr)]")}>
          <span aria-hidden className={cn("p-1.5 text-caption text-muted-foreground", !phone && "hidden sm:block")}>{t(key("pageTitle"))}</span>
          {at("top")}
        </div>
        {at("main")}
        {at("bottom")}
      </div>
      {trayNode}
    </div>
  );
}

/**
 * What opens over the page (dialogs, pop-ups): out of the page's own drawing, folded under it by default,
 * so the page reads first. Drawn only while open.
 */
function Tray({ areas, draw }: { areas: readonly SketchArea[]; draw: (region: SketchRegion) => ReactNode[] }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (areas.length === 0) return null;
  return (
    <div className="grid gap-2" data-sketch-region="tray">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(value => !value)}
        className="flex min-h-target w-fit items-center gap-1 rounded-sm text-caption text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-touch"
      >
        <ChevronRight aria-hidden className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        {t(key("popups"))}
      </button>
      {open && <div id={bodyId} className="grid gap-2">{draw("tray")}</div>}
    </div>
  );
}

function list(axis: SketchAxis): string {
  const gap = "gap-1.5";
  if (axis === "row") return cn("flex flex-wrap", gap);
  if (axis === "tiles") return cn("grid grid-cols-[repeat(auto-fill,minmax(min(7rem,100%),1fr))]", gap);
  return cn("grid", gap);
}

/**
 * An area's blocks as the real page arranges them (the editor and the maps of use share it): the
 * Dashboard's flow with the rail beside the timeline (dashboardSegments, as Dashboard.tsx), the sidebar's
 * actions around the running timer, else a plain row, column or grid of tiles. `nested` draws an area that
 * sits inside this one.
 */
export function AreaBlocks({ area, sketch, anchorIds, tileFor, nested }: {
  area: SketchArea;
  sketch: Sketch;
  anchorIds: readonly string[];
  tileFor: (anchorId: string) => ReactNode;
  nested: (areaId: string) => ReactNode;
}) {
  const gap = "gap-1.5";
  if (area.axis === "flow") {
    const wide = sketch.frame === "page";
    const { lead, segments } = dashboardSegments(anchorIds);
    // The secondary area: a band above the timeline, as on the page; on a phone right after it.
    const top = nested("dashboard.secondary");
    const leadTile = lead && <div className="grid min-w-0 content-start">{tileFor(lead)}</div>;
    return (
      <div className={cn("grid", gap)}>
        {wide ? <>{top}{leadTile}</> : <>{leadTile}{top}</>}
        {segments.map(segment => segment.kind === "band"
          ? <Fragment key={segment.anchorId}>{tileFor(segment.anchorId)}</Fragment>
          : (
            <div key={String(segment.items[0])} className={cn("grid", gap, wide && segment.items.includes("dashboard.summary") && segment.items.some(item => typeof item !== "string") && "sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.45fr)]")}>
              {segment.items.map(item => typeof item === "string"
                ? <div key={item} className="grid min-w-0 content-start">{tileFor(item)}</div>
                : <div key={item.join("+")} className={cn("grid min-w-0 content-start", gap)}>{item.map(anchorId => tileFor(anchorId))}</div>)}
            </div>
          ))}
      </div>
    );
  }
  if (area.areaId === "shell.actions") {
    const { before, after } = sidebarActionSegments(anchorIds, anchorIds.indexOf("shell.quick-start"));
    return <div className={cn("grid", gap)}>{before.map(tileFor)}{nested("shell.timer")}{after.map(tileFor)}</div>;
  }
  return <div className={list(area.axis)}>{anchorIds.map(tileFor)}</div>;
}
