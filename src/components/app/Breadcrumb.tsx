import { cn } from "@/lib/utils";
import { BACK_KEYS } from "@/lib/dom";
import { Link, useLocation } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { navEntryFor } from "@/lib/nav";
import { useBack } from "@/hooks/useNavHistory";
import { t } from "@/i18n";

/** A step between the page and the current item (a folder on the way to a note). */
export type BreadcrumbStep = { label: string; to: string };

/**
 * "Gruppo › Pagina [› steps…] [› current]" trail. On a detail page opened from
 * elsewhere it says where you came from instead ("Board › DEMO-1"), and
 * that step goes back there.
 */
export function Breadcrumb({ current, trail = [] }: { current?: string; trail?: BreadcrumbStep[] }) {
  const { pathname } = useLocation();
  const back = useBack();
  const entry = navEntryFor(pathname);
  if (!entry) return null;
  const via = current && back;
  // A trail that only repeats the title ("Main › Timesheet" over "Timesheet", "Notes › A note" over "A
  // note", whose page has its own way back on a phone): on a phone or tablet, where height is short, it
  // gives way, the same on a section and on its item, so the header never jumps between the two. A trail
  // that leads somewhere (a parent, a folder) stays.
  const repeatsTitle = trail.length === 0 && !entry.parent;
  return (
    <nav aria-label={t("ui.breadcrumb.label")} className={cn("mb-1", repeatsTitle && "max-lg:hidden")}>
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-caption font-medium text-muted-foreground">
        {!via && (
          <>
            <li>
              {entry.parent ? (
                <Link to={entry.parent.to} className="hover:text-foreground hover:underline underline-offset-4">
                  {entry.parent.label}
                </Link>
              ) : (
                entry.group
              )}
            </li>
            <li aria-hidden>
              <ChevronRight className="h-3 w-3" />
            </li>
          </>
        )}
        <li>
          {via ? (
            <button type="button" onClick={back.go} className="hover:text-foreground hover:underline underline-offset-4">
              {back.label}
            </button>
          ) : current ? (
            <Link to={entry.to} className="hover:text-foreground hover:underline underline-offset-4">
              {entry.label}
            </Link>
          ) : (
            <span aria-current="page">{entry.label}</span>
          )}
        </li>
        {trail.map(step => (
          <li key={step.to} className="flex min-w-0 items-center gap-1">
            <ChevronRight aria-hidden className="h-3 w-3 shrink-0" />
            <Link to={step.to} className="max-w-[12rem] truncate hover:text-foreground hover:underline underline-offset-4">
              {step.label}
            </Link>
          </li>
        ))}
        {current && (
          <>
            <li aria-hidden>
              <ChevronRight className="h-3 w-3" />
            </li>
            <li aria-current="page" className="truncate">
              {current}
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}

/** "← Board": back where this page was opened from, with its filters and scroll. */
export function BackButton({ fallback = null }: { fallback?: React.ReactNode }) {
  const back = useBack();
  if (!back) return fallback;
  return (
    <button
      type="button"
      onClick={back.go}
      title={t("ui.nav.backTo", { label: back.label, keys: BACK_KEYS })}
      className="-ml-1.5 mb-1 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-body-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden />
      {back.label}
    </button>
  );
}
