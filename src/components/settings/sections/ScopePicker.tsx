import { surface } from "@/components/app/surface";
import { cn } from "@/lib/utils";
import type { SketchFrame } from "@/lib/workspace/sketch";

export type ScopeOption<T extends string> = { value: T; label: string; frame: SketchFrame };

/**
 * The part of the app to arrange, as cards: each with a tiny outline of its frame (a page, a phone,
 * the sidebar beside a page, a phone with its tab bar), so the choice reads before its words. One
 * radio group: one Tab stop, the arrows move the choice.
 */
export function ScopePicker<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly ScopeOption<T>[]; onChange: (value: T) => void }) {
  const move = (group: HTMLElement, step: 1 | -1 | "first" | "last") => {
    const at = options.findIndex(option => option.value === value);
    const next = step === "first" ? 0 : step === "last" ? options.length - 1 : (at + step + options.length) % options.length;
    onChange(options[next].value);
    group.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      onKeyDown={event => {
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "Home" ? "first" : event.key === "End" ? "last" : null;
        if (step === null) return;
        event.preventDefault();
        move(event.currentTarget, step);
      }}
    >
      {options.map(option => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            {...surface("control", { on: checked })}
            className={cn(
              "flex min-h-touch min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-body-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              checked ? "border-primary-strong/50 bg-primary-soft font-medium text-foreground" : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <FrameIcon frame={option.frame} on={checked} />
            <span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A frame drawn in a few lines (decorative: the label says it). */
function FrameIcon({ frame, on }: { frame: SketchFrame; on: boolean }) {
  const line = on ? "border-primary-strong" : "border-current";
  const fill = on ? "bg-primary-strong/35" : "bg-current opacity-30";
  if (frame === "page") {
    return (
      <span aria-hidden className={cn("grid h-6 w-8 shrink-0 grid-cols-[2fr_1fr] grid-rows-[auto_1fr] gap-0.5 rounded-sm border p-0.5", line)}>
        <span className={cn("col-span-2 h-1", fill)} />
        <span className={cn("", fill)} />
        <span className={cn("", fill)} />
      </span>
    );
  }
  if (frame === "phone-page") {
    return (
      <span aria-hidden className="flex h-6 w-8 shrink-0 justify-center">
        <span className={cn("grid h-6 w-4 grid-rows-[auto_1fr_1fr] gap-0.5 rounded-sm border p-0.5", line)}>
          <span className={cn("h-0.5", fill)} />
          <span className={cn("", fill)} />
          <span className={cn("", fill)} />
        </span>
      </span>
    );
  }
  if (frame === "sidebar") {
    return (
      <span aria-hidden className={cn("grid h-6 w-8 shrink-0 grid-cols-[1fr_2fr] gap-0.5 rounded-sm border p-0.5", line)}>
        <span className={cn("", fill)} />
        <span />
      </span>
    );
  }
  return (
    <span aria-hidden className="flex h-6 w-8 shrink-0 justify-center">
      <span className={cn("grid h-6 w-4 grid-rows-[1fr_auto] gap-0.5 rounded-sm border p-0.5", line)}>
        <span />
        <span className={cn("h-1", fill)} />
      </span>
    </span>
  );
}
