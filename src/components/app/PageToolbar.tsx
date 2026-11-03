import { usePublishChromeHeight } from "@/lib/layout/chrome";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";

/**
 * The row of a page's own controls (scope, search, filters, view) under its header. On desktop it
 * sticks right under the sticky PageHeader (--page-header-h) and publishes its own height
 * (--page-toolbar-h on the page) for what sticks below it and for scroll padding. Opaque ground,
 * never blurred (it sits over the Dashboard's moving backdrop); its rows wrap at 320 px.
 * The height is read once per size change (a ResizeObserver), never on scroll.
 */
export function PageToolbar({
  children,
  label,
  className,
}: {
  children: React.ReactNode;
  /** The toolbar's accessible name: "Filters", "View". */
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const page = el?.parentElement;
    if (!el || !page) return;
    const ro = new ResizeObserver(() => page.style.setProperty("--page-toolbar-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      page.style.removeProperty("--page-toolbar-h");
    };
  }, []);
  usePublishChromeHeight(ref, "toolbar");
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      {...surface("ground")}
      className={cn(
        "flex flex-wrap items-center gap-2 border-b bg-card px-5 py-2 md:px-6",
        // Under the Kanbunny overlay's z-10, with the header (z-20): the same layer as the header.
        "lg:sticky lg:top-[var(--page-header-h,0px)] lg:z-20",
        "group-has-[[data-module-slot=dashboard-backdrop]]/panel:bg-card/[0.97]",
        className
      )}
    >
      {children}
    </div>
  );
}
