import { LayoutPanelLeft, X } from "lucide-react";
import { DESK_MAX_PANES } from "@contracts/desk";
import { surface } from "@/components/app/surface";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/**
 * Issues picked in the list (x, the checkboxes): how many, "Open on desk" (at most six fit:
 * above that the button says why it can't) and Clear. Stays at the bottom of the list while it
 * scrolls, above a phone's tab bar.
 */
export function SelectionBar({ count, onOpen, onClear }: { count: number; onOpen: () => void; onClear: () => void }) {
  if (!count) return null;
  const tooMany = count > DESK_MAX_PANES;
  return (
    <div className="pointer-events-none sticky bottom-[calc(var(--bottom-nav-h)+0.75rem)] z-20 mt-3 flex justify-center lg:bottom-4">
      <div
        role="region"
        aria-label={t("pages.issues.selection.label")}
        {...surface("menu")}
        className="pointer-events-auto flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-popover py-1.5 pl-4 pr-1.5 text-body-sm shadow-sm"
      >
        <span role="status" className="font-medium tabular">
          {t("pages.issues.selection.count", { count })}
        </span>
        {tooMany && <span className="text-caption text-muted-foreground">{t("pages.issues.selection.tooMany", { max: DESK_MAX_PANES })}</span>}
        <span className="flex items-center gap-1">
          <Button size="sm" onClick={onOpen} disabled={tooMany} title={tooMany ? t("pages.issues.selection.tooMany", { max: DESK_MAX_PANES }) : undefined}>
            <LayoutPanelLeft className="h-4 w-4" aria-hidden />
            {t("pages.issues.selection.open")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear} title={t("pages.issues.selection.clearTitle")}>
            <X className="h-4 w-4" aria-hidden />
            {t("pages.issues.selection.clear")}
          </Button>
        </span>
      </div>
    </div>
  );
}
