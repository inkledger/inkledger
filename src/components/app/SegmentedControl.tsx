import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";

/** Pill segmented control (radio group semantics, arrow-key navigable). */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: {
    value: T;
    label: string;
    icon?: React.ComponentType<{ className?: string }>;
  }[];
  /** Accessible name of the group */
  label: string;
  className?: string;
}) {
  const hasValue = options.some(o => o.value === value);
  const move = (group: HTMLElement, dir: 1 | -1 | "first" | "last") => {
    const i = options.findIndex(o => o.value === value);
    const n = dir === "first" ? 0 : dir === "last" ? options.length - 1 : (i + dir + options.length) % options.length;
    onChange(options[n].value);
    // Roving tabindex: focus follows the selection, or it would stay on a -1 button.
    group.querySelectorAll<HTMLButtonElement>('[role="radio"]')[n]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      // Under a light the chosen option stands out of the group.
      {...surface("ground")}
      className={cn(
        // Wraps on a narrow screen: every option stays on it, never cut off.
        "inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg border bg-muted/70 p-0.5",
        className
      )}
      onKeyDown={e => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(e.currentTarget, 1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(e.currentTarget, -1);
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          move(e.currentTarget, e.key === "Home" ? "first" : "last");
        }
      }}
    >
      {options.map(({ value: v, label: l, icon: Icon }, i) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            {...surface("control", { on: active })}
            // With no selection the first option keeps the group reachable.
            tabIndex={active || (!hasValue && i === 0) ? 0 : -1}
            onClick={() => onChange(v)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-body-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-card text-foreground shadow-xs ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {Icon && <Icon className="h-4 w-4" />}
            {l}
          </button>
        );
      })}
    </div>
  );
}
