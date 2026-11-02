import { useId, useLayoutEffect, useRef, useState } from "react";
import { surface } from "@/components/app/surface";
import type { BlockPath } from "@/lib/workspace/layers";

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Geometry = { width: number; height: number; rects: ReadonlyMap<string, Rect> };
/** One arrow as drawn; `exit` is where it leaves the frame when it leads off this page. */
type Drawn = { path: BlockPath; d: string; exit: Point | null };

/** Thinnest and thickest arrow, in px: the busiest path of the period is the thickest. */
const THIN = 1.5;
const THICK = 5;
/** Off-page labels never closer than this, top to top (px). */
const LABEL_GAP = 24;

const centre = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

/** Where the line from a rect's centre towards `to` leaves the rect: arrows join edges, never cover a name. */
function edge(rect: Rect, to: Point): Point {
  const from = centre(rect);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const scale = Math.min(dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx), dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy));
  return { x: from.x + dx * Math.min(1, scale), y: from.y + dy * Math.min(1, scale) };
}

/** A gentle curve from `a` to `b`, bent to one side so two arrows between neighbours stay apart. */
function curve(a: Point, b: Point): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(36, length * 0.2);
  const control = { x: (a.x + b.x) / 2 - (dy / length) * bend, y: (a.y + b.y) / 2 + (dx / length) * bend };
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

/**
 * The Paths layer: arrows over the page drawing from each block to the one used next, as often as the
 * period says (the thicker, the more often). A path leading off this page ends at the frame's edge with
 * the name of where it goes. Measured from the drawn blocks (`[data-anchor]` inside `[data-layout-canvas]`
 * of the same parent), again whenever they change size. Decorative: the details panel and the table
 * say the same in words.
 */
export function PathsOverlay({ paths, destination, version }: {
  paths: readonly BlockPath[];
  /** Where a path off this page goes, by name. */
  destination: (path: BlockPath) => string;
  /** Changes when the blocks move: measured again. */
  version: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const marker = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  useLayoutEffect(() => {
    const host = svg.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const box = host.getBoundingClientRect();
      const rects = new Map<string, Rect>();
      for (const element of host.querySelectorAll<HTMLElement>("[data-layout-canvas] [data-anchor]")) {
        const anchorId = element.getAttribute("data-anchor");
        const rect = element.getBoundingClientRect();
        if (anchorId && rect.width > 0 && rect.height > 0) rects.set(anchorId, { x: rect.left - box.left, y: rect.top - box.top, width: rect.width, height: rect.height });
      }
      setGeometry({ width: box.width, height: box.height, rects });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    for (const element of host.querySelectorAll("[data-layout-canvas] [data-anchor]")) observer.observe(element);
    return () => observer.disconnect();
  }, [version, paths]);

  const most = Math.max(1, ...paths.map(path => path.count));
  const width = (count: number) => Number((THIN + (THICK - THIN) * (count / most)).toFixed(2));
  const drawn: Drawn[] = geometry ? paths.flatMap((path): Drawn[] => {
    const from = geometry.rects.get(path.from);
    if (!from) return [];
    const target = path.to ? geometry.rects.get(path.to) : undefined;
    if (target) {
      const start = edge(from, centre(target));
      const end = edge(target, centre(from));
      return [{ path, d: curve(start, end), exit: null }];
    }
    // Off this page (or not drawn): straight to the frame's right edge, at the block's height.
    const start = edge(from, { x: geometry.width, y: centre(from).y });
    const end = { x: geometry.width - 2, y: start.y };
    return [{ path, d: `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`, exit: end }];
  }) : [];
  // Off-page labels stacked down the right edge, never on top of each other.
  const exits = drawn.filter(item => item.exit !== null).sort((a, b) => (a.exit?.y ?? 0) - (b.exit?.y ?? 0));
  const labels = exits.reduce<{ item: Drawn; top: number }[]>((placed, item) => {
    const floor = (placed.at(-1)?.top ?? -Infinity) + LABEL_GAP;
    return [...placed, { item, top: Math.max((item.exit?.y ?? 0) - LABEL_GAP / 2, floor) }];
  }, []);

  return (
    <>
      <svg ref={svg} data-paths aria-hidden className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible text-primary-strong">
        <defs>
          <marker id={marker} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3.5" markerHeight="3.5" orient="auto-start-reverse">
            <path d="M 0 0 L 6 3 L 0 6 z" fill="currentColor" />
          </marker>
        </defs>
        {drawn.map(({ path, d }) => (
          <path
            key={`${path.from}>${path.to ?? path.toControlId}`}
            d={d}
            data-path-from={path.from}
            data-path-to={path.to ?? ""}
            data-path-count={path.count}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeOpacity={0.75}
            strokeWidth={width(path.count)}
            markerEnd={`url(#${marker})`}
          />
        ))}
      </svg>
      {labels.map(({ item, top }) => (
        <span
          key={`exit:${item.path.from}>${item.path.toControlId}`}
          aria-hidden
          data-path-exit={item.path.toControlId}
          {...surface("chip")}
          style={{ top }}
          className="pointer-events-none absolute right-1 z-10 max-w-40 truncate rounded-sm border bg-card px-1.5 text-2xs leading-5 text-primary-strong"
        >
          → {destination(item.path)} <span className="tabular-nums text-muted-foreground">{item.path.count}</span>
        </span>
      ))}
    </>
  );
}
