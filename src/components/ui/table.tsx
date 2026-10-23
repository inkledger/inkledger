import * as React from "react";
import { ArrowDownUp } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Panel table: hairline rows, caption-size headings, scrolls sideways under
 * its `min-w-*` (pass it in `className`).
 */
function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<"table"> & { containerClassName?: string }) {
  return (
    <div
      data-slot="table-container"
      className={cn("cast-room-x cast-room-y overflow-x-auto [--room-shift-x:0.25rem]", containerClassName)}
    >
      <table
        data-slot="table"
        className={cn("w-full text-left text-body-sm", className)}
        {...props}
      />
    </div>
  );
}

/** Header row: caption size, muted labels. */
function TableHeaderRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("text-caption", className)} {...props} />;
}

/** Body row separated by a hairline. */
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("border-t", className)} {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      scope="col"
      data-slot="table-head"
      className={cn("pb-2 font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

/** Column heading that sorts on click; `sort` is its aria-sort state. */
function SortableHead({
  sort,
  onSort,
  className,
  children,
}: {
  sort: "ascending" | "descending" | "none";
  onSort: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <th
      scope="col"
      aria-sort={sort}
      data-slot="table-head"
      className={cn("pb-2 font-medium", className)}
    >
      <button
        type="button"
        onClick={onSort}
        className={cn(
          "inline-flex items-center gap-1.5 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
          sort !== "none" && "text-foreground"
        )}
      >
        {children}
        <ArrowDownUp className="h-3.5 w-3.5 opacity-60" aria-hidden />
      </button>
    </th>
  );
}

export { Table, TableHeaderRow, TableRow, TableHead, SortableHead };
