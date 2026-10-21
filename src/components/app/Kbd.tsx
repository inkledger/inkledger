import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";

/** A key or shortcut hint: inline in menus and footers, `lg` in the shortcuts list. */
export function Kbd({
  size = "sm",
  className,
  ...props
}: React.ComponentProps<"kbd"> & { size?: "sm" | "lg" }) {
  return (
    <kbd
      {...surface("chip")}
      className={cn(
        "rounded border bg-muted",
        size === "sm"
          ? "px-1.5 text-2xs"
          : "min-w-6 rounded-md px-1.5 py-0.5 text-center text-caption font-medium shadow-xs",
        className
      )}
      {...props}
    />
  );
}
