import { Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { t } from "@/i18n";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label={t("ui.loadingLabel")}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
