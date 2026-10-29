import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * A block of the page panel (reference layout): sections are separated by
 * hairlines, not boxed. Use `className` for grid placement and borders
 * (e.g. "xl:border-r").
 */
export function PanelSection({
  title,
  actions,
  className,
  children,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={title ? id : undefined}
      className={cn("min-w-0 p-5 md:p-6", className)}
    >
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && (
            <h2 id={id} className="font-display text-heading">
              {title}
            </h2>
          )}
          {actions && (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/** A row of sections divided by hairlines; children decide their columns. */
export function PanelRow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-[minmax(0,1fr)] border-b last:border-b-0",
        className
      )}
    >
      {children}
    </div>
  );
}
