import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    // surface: none — a sunk field: it never casts
    <textarea
      data-slot="textarea"
      data-focus="inset"
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring dark:bg-input/30 flex min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-field shadow-xs transition-[color,box-shadow] outline-clear disabled:cursor-not-allowed disabled:opacity-50 md:text-body-sm",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
