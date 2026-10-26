import { Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/** `decorative`: inside a region that already says it is loading (one status, never two). */
function Spinner({ className, decorative = false, ...props }: React.ComponentProps<"svg"> & { decorative?: boolean }) {
  return (
    <Loader2Icon
      {...(decorative ? { "aria-hidden": true } : { role: "status", "aria-label": t("ui.loadingLabel") })}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
