import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";

/**
 * The app's one row (docs/design-system.md §7.1): what leads (an avatar, a dot), a title on one line
 * and an optional second line, then what trails (figures, actions). Its height is a minimum, never a
 * fixed value, so text spacing and zoom can wrap it (WCAG 1.4.12); 24 px at least, a finger's 44 px on a
 * touch screen. Density is the root font and the block's variant (`--row-pad`), not the row's own.
 */
export function ListRow({ lead, title, meta, trail, className }: { lead?: ReactNode; title: ReactNode; meta?: ReactNode; trail?: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-h-target grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-[var(--row-pad,0.5rem)] coarse:min-h-touch", !lead && "grid-cols-[minmax(0,1fr)_auto]", className)}>
      {lead && <span className="flex shrink-0 items-center">{lead}</span>}
      <span className="grid min-w-0">
        <span className="truncate text-body-sm font-medium">{title}</span>
        {meta && <span className="truncate text-caption text-muted-foreground">{meta}</span>}
      </span>
      {trail ? <span className="flex shrink-0 items-center gap-1.5">{trail}</span> : <span />}
    </div>
  );
}

/** The app's one card (a board's issue, a planned entry, an idea): a raised box with the same padding. */
export function ItemCard({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...surface("card")} {...rest} className={cn("relative grid gap-1.5 rounded-xl border bg-card p-2.5 text-body-sm", className)}>
      {children}
    </div>
  );
}
