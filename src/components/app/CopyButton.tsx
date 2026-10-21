import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** Copies `text`; says "Copied" for a moment (works on pages without toasts). */
export function CopyButton({ text, label = t("ui.copy.copy") }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined)
      }
    >
      {done ? <Check /> : <Copy />}
      {done ? t("ui.copy.copied") : label}
    </Button>
  );
}
