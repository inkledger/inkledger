import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  sidebarSections,
  useSidebarSectionsClosed,
} from "@/hooks/useSidebarSections";

/**
 * A sidebar group whose title folds it away. Folded, a dot says whether the
 * current page (or news) is inside.
 */
export function SidebarSection({
  name,
  title,
  hint = false,
  action,
  className,
  bodyClassName,
  children,
}: {
  /** Stable id (what is remembered as folded) */
  name: string;
  /** What the title says, when it differs from `name` (translated) */
  title?: string;
  /** Something inside deserves attention (active page, news) */
  hint?: boolean;
  /** Extra control on the title row (e.g. "All") */
  action?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  const open = !useSidebarSectionsClosed().includes(name);
  const id = `sidebar-section-${name.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex shrink-0 items-center justify-between pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => sidebarSections.toggle(name)}
          className="group flex min-h-target items-center gap-1 rounded-sm px-3 text-overline uppercase text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {title ?? name}
          <ChevronDown
            aria-hidden
            className={cn(
              "h-3 w-3 opacity-0 transition-[transform,opacity] group-hover:opacity-100 group-focus-visible:opacity-100",
              !open && "-rotate-90 opacity-100"
            )}
          />
          {!open && hint && (
            <span
              aria-hidden
              className="ml-0.5 h-1.5 w-1.5 rounded-full bg-primary-strong"
            />
          )}
        </button>
        {open && action}
      </div>
      {open && (
        <div id={id} className={cn("flex flex-col gap-1", bodyClassName)}>
          {children}
        </div>
      )}
    </div>
  );
}
