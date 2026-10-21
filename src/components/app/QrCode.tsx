import { encode } from "uqr";
import { cn } from "@/lib/utils";

/**
 * A QR code drawn as one SVG path (dark modules on a light tile, always:
 * cameras read dark-on-light best, also in dark mode), with the standard
 * quiet zone around it.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { data, size } = encode(value, { ecc: "M" });
  const quiet = 2;
  const total = size + quiet * 2;
  let d = "";
  data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    })
  );
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      className={cn("rounded-lg bg-qr text-qr-ink", className)}
    >
      <path d={d} fill="currentColor" />
    </svg>
  );
}
