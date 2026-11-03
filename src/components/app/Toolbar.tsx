import { Fragment, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

export type ToolbarItem = {
  key: string;
  /** The control as it stands in the bar. */
  node: ReactNode;
  /**
   * The same action as a menu item, for when the bar is too narrow for it: then the bar's copy is
   * display:none (out of the tab order and the accessibility tree) and this one waits behind ⋯.
   * Without it the item never folds.
   */
  menu?: ReactNode;
};

/** Static classes (Tailwind sees whole names): fold below the region size `foldBelow`. */
const FOLDED: Record<"m" | "l" | "xl", string> = { m: "hidden @m:contents", l: "hidden @l:contents", xl: "hidden @xl:contents" };
const MORE: Record<"m" | "l" | "xl", string> = { m: "@m:hidden", l: "@l:hidden", xl: "@xl:hidden" };

/**
 * A header's controls (docs/design-system.md §7.1, Apple's toolbar rule): at most three groups (what the
 * page shows, where it goes, its main action), and as the region it stands in narrows the items that
 * have a menu form fold behind ⋯, so the title never wraps for the controls. The region is the nearest
 * `region` ancestor (PageHeader is one): a toolbar sized by its content could not measure itself.
 * Nothing is removed: a folded item is one click away, the same action, the same FlowMap control.
 */
export function Toolbar({ label, groups, foldBelow = "xl", className }: { label: string; groups: readonly (readonly ToolbarItem[])[]; foldBelow?: "m" | "l" | "xl"; className?: string }) {
  const folding = groups.flat().filter(item => item.menu !== undefined);
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap items-center gap-2", className)}>
      {groups.map((group, index) => (
        <div key={index} className="flex items-center gap-1.5">
          {group.map(item => (
            <span key={item.key} className={item.menu !== undefined ? FOLDED[foldBelow] : "contents"}>
              {item.node}
            </span>
          ))}
        </div>
      ))}
      {folding.length > 0 && (
        <span className={MORE[foldBelow]}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("ui.toolbar.more")} title={t("ui.toolbar.more")}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {folding.map(item => (
                <Fragment key={item.key}>{item.menu}</Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
    </div>
  );
}
