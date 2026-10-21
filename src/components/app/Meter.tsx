import { cn } from "@/lib/utils";
import { surface, surfaceFace } from "@/components/app/surface";

const SIZE = {
  xs: "h-1",
  sm: "h-1.5",
  md: "h-2",
  lg: "h-3",
} as const;

const pctOf = (v: number, max: number) =>
  max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;

/**
 * Horizontal meter: a filled share of `max`, optionally followed by hatched
 * "tracked but not yet logged" time and a target marker. With a `label` it is
 * an accessible progressbar, otherwise decorative (the number is shown nearby).
 */
export function Meter({
  value,
  max,
  pending = 0,
  running = false,
  marker,
  tone = "bg-primary",
  size = "sm",
  label,
  valueNow,
  animate = false,
  lit = false,
  className,
}: {
  value: number;
  max: number;
  /** Hatched segment after the fill (live timers). */
  pending?: number;
  /** Animate the hatching (a timer is running). */
  running?: boolean;
  /** Position of a target tick, in the same unit as `max`. */
  marker?: number;
  tone?: string;
  size?: keyof typeof SIZE;
  label?: string;
  /** aria-valuenow, 0–100 (default: the fill share). */
  valueNow?: number;
  animate?: boolean;
  /** Stands out of the page under a module's light (the track clips: it is the face of a wrapper). */
  lit?: boolean;
  className?: string;
}) {
  const fill = pctOf(value, max);
  const hatch = pending > 0 ? Math.min(100 - fill, pctOf(pending, max)) : 0;
  const a11y = label
    ? {
        role: "progressbar" as const,
        "aria-label": label,
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": Math.round(Math.min(100, valueNow ?? fill)),
      }
    : { "aria-hidden": true };
  const track = (
    <div
      {...surfaceFace({ on: lit })}
      className={cn(
        "relative flex overflow-hidden rounded-full bg-muted",
        SIZE[size],
        className
      )}
      {...a11y}
    >
      <div
        className={cn(
          "h-full",
          hatch === 0 && "rounded-full",
          animate && "transition-[width] duration-500",
          tone
        )}
        style={{ width: `${fill}%` }}
      />
      {hatch > 0 && (
        <div
          className={cn(
            "stripes-pending h-full transition-[width] duration-1000 ease-linear",
            running && "stripes-live"
          )}
          style={{ width: `${hatch}%` }}
        />
      )}
      {marker !== undefined && marker > 0 && marker < max && (
        <span
          aria-hidden
          className="absolute inset-y-0 w-px bg-card"
          style={{ left: `${pctOf(marker, max)}%` }}
        />
      )}
    </div>
  );
  return lit ? (
    <div {...surface("bar", { role: "wrap" })} className="rounded-full">
      {track}
    </div>
  ) : (
    track
  );
}
