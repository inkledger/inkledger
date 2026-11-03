import { usePublishChromeHeight } from "@/lib/layout/chrome";
import { useEffect, useRef } from "react";
import { surface } from "@/components/app/surface";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { cn } from "@/lib/utils";
import { BackButton, Breadcrumb, type BreadcrumbStep } from "@/components/app/Breadcrumb";

/**
 * Page title row shared by every page (same as the dashboard header):
 * breadcrumb, h1 with optional addon (e.g. a date picker), description,
 * actions on the right. Also sets the document title.
 */
export function PageHeader({
  title,
  documentTitle,
  description,
  titleAddon,
  titleLead,
  titleProps,
  titleClassName,
  addonInline = false,
  breadcrumbCurrent,
  breadcrumbTrail,
  actions,
  sticky = false,
  back = false,
  className,
}: {
  title: React.ReactNode;
  /** Browser tab title when `title` is not plain text */
  documentTitle?: string;
  description?: React.ReactNode;
  titleAddon?: React.ReactNode;
  /** Before the title (an issue's grip, to drag it to the desk). */
  titleLead?: React.ReactNode;
  /** The title's own handlers (an issue's long press). */
  titleProps?: React.HTMLAttributes<HTMLHeadingElement>;
  titleClassName?: string;
  /**
   * The addon runs on after the title's last word (an issue's star and edit), not at the row's end: a
   * title on two lines fills the row, and an addon beside it ended up far from the text. No clamp then.
   */
  addonInline?: boolean;
  /** Extra breadcrumb level (e.g. the issue key on a detail page) */
  breadcrumbCurrent?: string;
  /** Steps between the section and the current item (the folders a note is in) */
  breadcrumbTrail?: BreadcrumbStep[];
  actions?: React.ReactNode;
  /** Stays at the top of the panel while it scrolls (desktop): for pages whose controls drive the content. */
  sticky?: boolean;
  /** A detail page: "← Board" back to where it was opened from (or its section). */
  back?: boolean;
  className?: string;
}) {
  useDocumentTitle(documentTitle ?? (typeof title === "string" ? title : ""));
  const ref = useRef<HTMLDivElement>(null);
  // A sticky header publishes its height (--page-header-h on the page) so a toolbar
  // below it can stick right under it.
  useEffect(() => {
    const el = ref.current;
    const page = el?.parentElement;
    if (!sticky || !el || !page) return;
    const ro = new ResizeObserver(() =>
      page.style.setProperty("--page-header-h", `${el.offsetHeight}px`)
    );
    ro.observe(el);
    return () => {
      ro.disconnect();
      page.style.removeProperty("--page-header-h");
    };
  }, [sticky]);
  usePublishChromeHeight(ref, "header", sticky);
  return (
    <div
      ref={ref}
      // The sticky header is ground; over the Dashboard backdrop (bg-card/[0.97]) it is near see-through but stays ground.
      {...surface("ground", { on: sticky })}
      className={cn(
        // A region: its toolbar folds by the header's own width (Toolbar), not the window's.
        "region flex flex-col gap-3 border-b px-5 py-4 md:px-6 xl:min-h-[4.5rem] xl:flex-row xl:items-center xl:justify-between xl:gap-6",
        sticky && "lg:sticky lg:top-0 lg:z-20 lg:bg-card",
        // Over the Dashboard's backdrop scene: nearly opaque, no backdrop blur (it would be redone on every frame of the scene).
        sticky &&
          "group-has-[[data-module-slot=dashboard-backdrop]]/panel:bg-card/[0.97]",
        className
      )}
    >
      <div className="min-w-0">
        {/* A detail page: one "← Board" (where it was opened from) instead of the trail. */}
        {back ? (
          <BackButton fallback={<Breadcrumb current={breadcrumbCurrent} trail={breadcrumbTrail} />} />
        ) : (
          <Breadcrumb current={breadcrumbCurrent} trail={breadcrumbTrail} />
        )}
        {addonInline ? (
          <div className="flex min-w-0 items-start gap-2">
            {titleLead}
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <h1 {...titleProps} className={cn("inline font-display text-heading sm:text-title", titleClassName)} aria-live="polite">
                {title}
              </h1>
              {titleAddon && <span className="ml-2 inline-flex items-center gap-2 align-[0.15em]">{titleAddon}</span>}
            </div>
          </div>
        ) : (
        <div className="flex min-w-0 items-center gap-2">
          {titleLead}
          <h1
            {...titleProps}
            className={cn(
              "line-clamp-2 min-w-0 [overflow-wrap:anywhere] font-display text-heading sm:text-title",
              titleClassName
            )}
            aria-live="polite"
          >
            {title}
          </h1>
          {titleAddon}
        </div>
        )}
        {description && (
          // One line on a phone (the page starts sooner), two from sm.
          <p className="mt-0.5 line-clamp-1 [overflow-wrap:anywhere] text-body-sm text-muted-foreground sm:line-clamp-2">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 xl:shrink-0 xl:flex-nowrap">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Small uppercase group label (sidebar groups, form groups, section
 * headings: render it as `h3` and so on with `as`).
 */
export function SectionLabel({
  as: Tag = "div",
  id,
  className,
  children,
}: {
  as?: "div" | "h2" | "h3";
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tag
      id={id}
      className={cn(
        "px-3 text-overline uppercase text-muted-foreground",
        className
      )}
    >
      {children}
    </Tag>
  );
}
