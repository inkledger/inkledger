import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FlowControlAttributes } from "@/lib/workspace/instrumentation";

/**
 * A secondary part of a page folded under its title (Timesheet's breakdown, an issue's notes): the
 * title says what is inside and how many, the content is drawn only while open. Open or closed by
 * the caller (`open` + `onOpenChange`, e.g. remembered per device) or on its own (`defaultOpen`).
 */
export function Disclosure({
  title,
  count,
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  control,
  children,
  className,
}: {
  title: string;
  count?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Counted by FlowMap where the caller says so (flowControlProps). */
  control?: FlowControlAttributes;
  children: React.ReactNode;
  className?: string;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const id = useId();
  const toggle = () => {
    const next = !open;
    if (controlled === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  return (
    <div className={cn("border-b", className)}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={toggle}
          {...control}
          className="flex min-h-target w-full items-center gap-2 px-5 py-2 text-left text-body-sm font-medium outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-6"
        >
          <ChevronDown aria-hidden className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          <span className="min-w-0 truncate">{title}</span>
          {count !== undefined && <span className="tabular text-caption text-muted-foreground">{count}</span>}
        </button>
      </h3>
      {open && (
        <div id={id} role="region" aria-label={title} className="px-5 pb-4 md:px-6">
          {children}
        </div>
      )}
    </div>
  );
}
