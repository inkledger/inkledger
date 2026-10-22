import { readStored, writeStored } from "@/lib/storage";
import { useState } from "react";
import { Plug, X } from "lucide-react";
import { Link } from "react-router";
import { useConnections } from "@/hooks/useConnections";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

const SKIPPED = "ikl-first-tracker-skipped";

function skipped(): boolean {
  return readStored(SKIPPED) === "1";
}

/**
 * A new account with no tracker yet (an invite just accepted, a fresh
 * admin): one bar inviting it to connect the first, until it does or says
 * not now.
 */
export function FirstTrackerBanner() {
  const list = useConnections();
  const [hidden, setHidden] = useState(skipped);
  if (hidden || !list.data || list.data.some(c => c.role === "tracker")) return null;
  const skip = () => {
    // Storage unavailable: hidden until the next visit.
    writeStored(SKIPPED, "1");
    setHidden(true);
  };
  return (
    <div className="border-b bg-primary-soft" role="status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-2 text-body-sm md:px-6">
        <Plug className="h-4 w-4 shrink-0 text-primary-strong" aria-hidden />
        <span className="text-foreground">{t("ui.firstTracker.text")}</span>
        <Button asChild size="sm" variant="ghost" className="h-7 px-2.5 text-primary-strong hover:bg-primary/10">
          <Link to="/settings/connections?add=1">{t("ui.firstTracker.action")}</Link>
        </Button>
        <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label={t("ui.firstTracker.skip")} onClick={skip}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
