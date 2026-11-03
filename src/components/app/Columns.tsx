import type { ReactNode } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { surface } from "@/components/app/surface";
import { Dot } from "@/components/app/Chip";
import { cn } from "@/lib/utils";

type Tone = Parameters<typeof Dot>[0]["tone"];

/**
 * A board column's head (Board, Ideas, the Dashboard's My issues): its status dot, its name, its count
 * and its own actions at the end. One look everywhere a column of cards stands.
 */
export function ColumnHeader({ title, count, tone, actions, className }: { title: string; count: number; tone?: Tone; actions?: ReactNode; className?: string }) {
  return (
    <div {...surface("card")} className={cn("flex min-h-9 items-center gap-2 rounded-lg border bg-card px-2.5 py-1 text-body-sm font-medium", className)}>
      {tone && <Dot tone={tone} />}
      <span className="min-w-0 truncate">{title}</span>
      <span className="text-muted-foreground tabular">{count}</span>
      {actions && <span className="ml-auto flex shrink-0 items-center">{actions}</span>}
    </div>
  );
}

/**
 * A column folded to its name (Board, Ideas, My issues): a narrow bar with the name written down it and
 * its count, the whole bar the button that opens it again. On a phone a short row instead of a bar.
 */
export function CollapsedColumn({ title, count, tone, label, onOpen, control, className }: {
  title: string;
  count: number;
  tone?: Tone;
  /** Its accessible name: "Show To do (12)". */
  label: string;
  onOpen: () => void;
  /** FlowMap attributes, where the caller counts it. */
  control?: Record<string, string>;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={false}
      aria-label={label}
      title={label}
      {...control}
      {...surface("control")}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-body-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:w-11 sm:flex-col sm:px-0 sm:py-3",
        className
      )}
    >
      <ChevronsLeftRight className="h-4 w-4 text-muted-foreground" aria-hidden />
      {tone && <Dot tone={tone} />}
      <span className="text-muted-foreground tabular">{count}</span>
      <span className="whitespace-nowrap sm:[writing-mode:vertical-rl]">{title}</span>
    </button>
  );
}
