import { cn } from "@/lib/utils";
import { hitStep } from "@/lib/workspace/sketch";

const DOT = {
  1: "h-1 w-1 opacity-40",
  2: "h-1.5 w-1.5 opacity-55",
  3: "h-2 w-2 opacity-70",
} as const;

/**
 * Where in a block the clicks landed: its 8×8 grid (`cells[y][x]`), one dot per spot clicked, bigger and
 * stronger the closer it comes to the map's busiest spot (`most`). Decorative: the counts are said elsewhere.
 */
export function HitGrid({ cells, most }: { cells: readonly (readonly number[])[]; most: number }) {
  return (
    <span aria-hidden className="grid h-full w-full grid-cols-8 grid-rows-8">
      {cells.flatMap((row, y) => row.map((count, x) => {
        const step = hitStep(count, most);
        return (
          <span key={`${x},${y}`} className="flex items-center justify-center">
            {step !== 0 && <span data-hit={`${x},${y}`} className={cn("rounded-full bg-primary-strong", DOT[step])} />}
          </span>
        );
      }))}
    </span>
  );
}
