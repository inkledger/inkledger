import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    // A shape, not content: the region holding it says it is loading.
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("shimmer rounded-md", className)}
      {...props}
    />
  );
}

export { Skeleton };
