import { nextIndex } from "@/lib/roving";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import type { FlowControlAttributes } from "@/lib/workspace/instrumentation";

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
    /** Counted by FlowMap where the caller says so (flowControlProps). */
    control?: FlowControlAttributes;
  }[];
  /** Accessible name of the group */
  label: string;
  className?: string;
}) {
  const hasValue = options.some(o => o.value === value);
  // The app's one roving rule (src/lib/roving.ts): arrows, Home/End, wrap, modifiers left alone.
  const move = (group: HTMLElement, n: number) => {
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
        const n = nextIndex(options.findIndex(o => o.value === value), options.length, e);
        if (n === null) return;
        e.preventDefault();
        move(e.currentTarget, n);
      }}
    >
      {options.map(({ value: v, label: l, icon: Icon, control }, i) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            {...surface("control", { on: active })}
            {...control}
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
