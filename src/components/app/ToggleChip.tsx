import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";

/**
 * Tonal on/off chip (aria-pressed): duration presets (`md`) and view
 * filters (`sm`, with icon and count).
 */
export function ToggleChip({
  pressed,
  size = "md",
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "aria-pressed"> & {
  pressed: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      // Stands out when it has a ground of its own: pressed, or the small filters' (always opaque).
      {...surface("control", { on: pressed || size === "sm" })}
      className={cn(
        "rounded-md border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        size === "md"
          ? "px-2.5 py-1 text-body-sm tabular"
          : "inline-flex h-7 items-center gap-1.5 px-2.5 text-caption font-medium",
        pressed
          ? "border-primary-strong/40 bg-primary-soft text-primary-strong"
          : size === "md"
            ? "hover:bg-accent"
            : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
        className
      )}
      {...props}
    />
  );
}
