import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";

export type BandPoint = {
  key: string;
  /** Short axis label (shown for a few points only) */
  label: string;
  /** What the tooltip and the table say for this point */
  title: string;
  /** Observed value (history), drawn as a dot; hollow when imputed */
  value?: number;
  imputed?: boolean;
  /** Forecast band and line */
  p10?: number;
  p50?: number;
  p90?: number;
};

/** The smallest 1, 2 or 5 × 10ⁿ at or above `v`: a scale line that reads as a round number. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find(m => m * p >= v - 1e-9) ?? 10) * p;
}

const W = 600;
const H = 160;
const PAD = { top: 8, bottom: 20, left: 4, right: 4 };

/**
 * One measure over time: what happened (dots), then a forecast (P10–P90 band,
 * P50 line). One series, so no legend: the section's title names it. The band
 * is the data accent (chart-focus); the line and dots wear chart-ink, which
 * reads against the card in both themes (the pale accent alone doesn't).
 * Hover or focus a column for its values; the same values sit in a table for
 * screen readers.
 */
export function BandChart({ points, unit, caption, className }: { points: BandPoint[]; unit: (v: number) => string; caption: string; className?: string }) {
  const [at, setAt] = useState<number | null>(null);
  const tableId = useId();
  const scale = niceCeil(Math.max(0, ...points.flatMap(p => [p.value ?? 0, p.p90 ?? 0])));
  const top = scale;
  const n = points.length;
  const step = (W - PAD.left - PAD.right) / Math.max(1, n);
  const x = (i: number) => PAD.left + step * (i + 0.5);
  const y = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / top);
  const fc = points.map((p, i) => ({ p, i })).filter(({ p }) => p.p50 !== undefined);
  const band =
    fc.length > 0
      ? `M${fc.map(({ p, i }) => `${x(i)},${y(p.p90!)}`).join("L")}L${[...fc].reverse().map(({ p, i }) => `${x(i)},${y(p.p10!)}`).join("L")}Z`
      : "";
  const line = fc.length > 0 ? `M${fc.map(({ p, i }) => `${x(i)},${y(p.p50!)}`).join("L")}` : "";
  // Axis labels: the first, the last and a few between, never crowded.
  const every = Math.max(1, Math.ceil(n / 6));
  const hovered = at === null ? null : points[at];
  return (
    <figure className={cn("relative grid gap-1", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={caption} aria-describedby={tableId}>
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line x1={PAD.left} x2={W - PAD.right} y1={y(scale)} y2={y(scale)} className="stroke-border" strokeWidth={1} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        {band && <path d={band} className="fill-chart-focus/50" />}
        {line && <path d={line} className="fill-none stroke-chart-ink" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
        {at !== null && <line x1={x(at)} x2={x(at)} y1={PAD.top} y2={y(0)} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
        {points.map((p, i) => (
          <g key={p.key}>
            {p.value !== undefined && (
              <ellipse
                cx={x(i)}
                cy={y(p.value)}
                rx={4 * (W / 600)}
                ry={4}
                className={p.imputed ? "fill-card stroke-chart-ink" : "fill-chart-ink stroke-card"}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {/* The hit target: the whole column, wider than the mark. */}
            <rect
              x={x(i) - step / 2}
              y={0}
              width={step}
              height={H}
              className="fill-transparent outline-none"
              tabIndex={0}
              aria-label={p.title}
              onMouseEnter={() => setAt(i)}
              onMouseLeave={() => setAt(null)}
              onFocus={() => setAt(i)}
              onBlur={() => setAt(null)}
            />
          </g>
        ))}
      </svg>
      <span className="pointer-events-none absolute left-1 top-0 text-caption text-muted-foreground tabular" aria-hidden>
        {unit(scale)}
      </span>
      <div className="relative h-4 text-caption text-muted-foreground" aria-hidden>
        {points.map((p, i) =>
          i % every === 0 ? (
            <span
              key={p.key}
              // At the edges a label leans inwards, never past the chart.
              className={cn("absolute whitespace-nowrap", x(i) / W < 0.1 ? "" : x(i) / W > 0.9 ? "-translate-x-full" : "-translate-x-1/2")}
              style={{ left: `${(x(i) / W) * 100}%` }}
            >
              {p.label}
            </span>
          ) : null,
        )}
      </div>
      {hovered && at !== null && (
        <div
          {...surface("menu")}
          className="pointer-events-none absolute top-0 z-10 max-w-[12rem] rounded-md border bg-popover px-2 py-1 text-caption text-popover-foreground"
          style={{ left: `clamp(0px, calc(${(x(at) / W) * 100}% - 6rem), calc(100% - 12rem))` }}
        >
          <div className="font-medium">{hovered.title}</div>
          {hovered.value !== undefined && <div className="tabular">{unit(hovered.value)}</div>}
          {hovered.p50 !== undefined && (
            <div className="tabular">
              {unit(hovered.p50)} <span className="text-muted-foreground">({unit(hovered.p10!)}–{unit(hovered.p90!)})</span>
            </div>
          )}
        </div>
      )}
      <table id={tableId} className="sr-only">
        <caption>{caption}</caption>
        <tbody>
          {points.map(p => (
            <tr key={p.key}>
              <th scope="row">{p.title}</th>
              <td>{p.value !== undefined ? unit(p.value) : p.p50 !== undefined ? `${unit(p.p50)} (${unit(p.p10!)}–${unit(p.p90!)})` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
