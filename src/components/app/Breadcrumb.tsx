import { BACK_KEYS } from "@/lib/dom";
import { Link, useLocation } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { navEntryFor } from "@/lib/nav";
import { useBack } from "@/hooks/useNavHistory";
import { t } from "@/i18n";

/**
 * "Gruppo › Pagina [› current]" trail. On a detail page opened from
 * elsewhere it says where you came from instead ("Board › DEMO-1"), and
 * that step goes back there.
 */
export function Breadcrumb({ current }: { current?: string }) {
  const { pathname } = useLocation();
  const back = useBack();
  const entry = navEntryFor(pathname);
  if (!entry) return null;
  const via = current && back;
  return (
    <nav aria-label={t("ui.breadcrumb.label")} className="mb-1">
      <ol className="flex items-center gap-1 text-caption font-medium text-muted-foreground">
        {!via && (
          <>
            <li>{entry.group}</li>
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
