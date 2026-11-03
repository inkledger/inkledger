import { cn } from "@/lib/utils";
import { nextIndex } from "@/lib/roving";
import { surface } from "@/components/app/surface";
import type { FlowControlAttributes } from "@/lib/workspace/instrumentation";

export type TabItem<T extends string> = {
  value: T;
  label: string;
  /** A count beside the label (open items, entries). */
  count?: number;
  /** Counted by FlowMap where the caller says so (flowControlProps). */
  control?: FlowControlAttributes;
};

/**
 * Sections of one page shown one at a time (Reports: Period · Accuracy · Forecast). One Tab stop,
 * the arrows move and select, Home/End jump; arrows with a modifier are left to the app (history,
 * the Desk). Controlled: the caller keeps the value, in the URL so Back and scroll restoration find it.
 * Panels are `TabPanel`s with the same `idBase`.
 */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  idBase,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  items: readonly TabItem<T>[];
  label: string;
  /** Ties each tab to its panel (aria-controls / aria-labelledby). */
  idBase: string;
  className?: string;
}) {
  const current = items.findIndex(item => item.value === value);
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("flex max-w-full flex-wrap items-end gap-1 border-b", className)}
      onKeyDown={event => {
        const next = nextIndex(current, items.length, event);
        if (next === null) return;
        event.preventDefault();
        onChange(items[next].value);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${idBase}-tab-${item.value}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${item.value}`}
            tabIndex={selected || (current === -1 && index === 0) ? 0 : -1}
            onClick={() => onChange(item.value)}
            {...surface("control", { on: selected })}
            {...item.control}
            className={cn(
              "-mb-px inline-flex min-h-target items-center gap-1.5 border-b-2 px-3 py-1.5 text-body-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              selected ? "border-primary-strong text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {item.label}
            {/* What a tab holds, said on the tab: a closed tab with something in it stands out (a soft badge). */}
            {item.count !== undefined && (
              <span className={cn("rounded-full px-1.5 text-caption tabular", item.count > 0 ? "bg-primary-soft font-semibold text-primary-strong" : "text-muted-foreground")}>{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** One tab's content: rendered only while chosen (what is not shown costs nothing). */
export function TabPanel<T extends string>({ value, current, idBase, children, className }: { value: T; current: T; idBase: string; children: React.ReactNode; className?: string }) {
  if (value !== current) return null;
  return (
    <div role="tabpanel" id={`${idBase}-panel-${value}`} aria-labelledby={`${idBase}-tab-${value}`} tabIndex={0} className={cn("outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", className)}>
      {children}
    </div>
  );
}
