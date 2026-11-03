import { useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/**
 * A bounded collection (docs/design-system.md §7.1, Material's feed): a grid as wide as its own
 * container (1 column below 28rem, then 2, 3, 4 from 80rem, at most `maxColumns`), showing `rows` rows,
 * then "Show all N" (the total, the same at every width). Expanded in place, focus on the first item that
 * was hidden; or, with `moreTo`, the button leads to the page that holds them all. Which items fit is
 * decided by CSS alone (src/index.css "Collection"): no measuring, no re-render on resize, the same
 * markup on the server. Never a rail scrolled sideways, never a mask over focusable items.
 */
export function Collection<T>({
  items,
  keyOf,
  render,
  rows = 2,
  maxColumns = 4,
  label,
  more,
  className,
  itemClassName,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
  /** How many rows before "Show all": 1 to 4 (a workspace variant may change it). */
  rows?: 1 | 2 | 3 | 4;
  maxColumns?: 1 | 2 | 3 | 4;
  /** The list's accessible name. */
  label: string;
  /** Instead of expanding in place: a control leading to the full set (a link to the page that has them all). */
  more?: (total: number) => ReactNode;
  className?: string;
  itemClassName?: string;
}) {
  const [all, setAll] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const expand = () => {
    // The first item the budget hid, read before it shows: focus goes there, not back to the top.
    const hidden = [...(list.current?.children ?? [])].findIndex(child => getComputedStyle(child).display === "none");
    setAll(true);
    if (hidden >= 0)
      requestAnimationFrame(() => {
        const target = list.current?.children[hidden]?.querySelector<HTMLElement>("a[href], button, [tabindex]");
        target?.focus();
      });
  };
  return (
    <div className={cn("collection grid gap-2", className)} data-rows={all ? undefined : rows} data-max-cols={maxColumns}>
      <ul ref={list} aria-label={label} className="collection-items">
        {items.map(item => (
          <li key={keyOf(item)} className={cn("min-w-0", itemClassName)}>
            {render(item)}
          </li>
        ))}
      </ul>
      <div className="collection-more justify-self-start">
        {more ? (
          more(items.length)
        ) : all ? (
          <Button variant="ghost" size="sm" aria-expanded onClick={() => setAll(false)}>
            <ChevronUp className="h-4 w-4" aria-hidden />
            {t("ui.collection.showFewer")}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" aria-expanded={false} onClick={expand}>
            <ChevronDown className="h-4 w-4" aria-hidden />
            {t("ui.collection.showAll", { count: items.length })}
          </Button>
        )}
      </div>
    </div>
  );
}
