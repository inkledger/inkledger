import { cn } from "@/lib/utils";

export function ActionRow({
  leading,
  children,
  actions,
  className,
  contentClassName,
  actionsClassName,
}: {
  leading?: React.ReactNode;
  children: React.ReactNode;
  actions: React.ReactNode;
  className?: string;
  contentClassName?: string;
  actionsClassName?: string;
}) {
  return (
    <div
      data-action-row
      className={cn(
        "grid min-w-0 items-center gap-2",
        leading
          ? "grid-cols-[auto_minmax(0,1fr)_auto]"
          : "grid-cols-[minmax(0,1fr)_auto]",
        className
      )}
    >
      {leading}
      <div className={cn("min-w-0 [overflow-wrap:anywhere]", contentClassName)}>{children}</div>
      <div className={cn("flex shrink-0 items-center gap-1", actionsClassName)}>
        {actions}
      </div>
    </div>
  );
}
