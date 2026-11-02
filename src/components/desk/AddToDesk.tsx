import { useState } from "react";
import { Plus } from "lucide-react";
import { addPane, paneId, type DeskLayout, type DeskPane } from "@contracts/desk";
import { announceAdd } from "@/lib/desk/announce";
import { trpc } from "@/lib/trpc";
import { visibleIssues } from "@/lib/issues";
import { IssuePicker } from "@/components/app/IssuePicker";
import { Button } from "@/components/ui/button";
import type { DeskChange } from "@/lib/desk/useDesk";
import { t } from "@/i18n";

/**
 * "Add issue": the issue picker; the issue chosen joins the desk (a full desk parks
 * its last pane) and takes the focus. `icon` draws only the plus (the phone's tabs).
 */
export function AddToDesk({
  desk,
  change,
  onAdded,
  variant = "default",
  icon = false,
}: {
  desk: DeskLayout;
  change: (fn: DeskChange) => void;
  onAdded: (id: string) => void;
  variant?: "default" | "outline" | "ghost";
  icon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const issues = trpc.issues.all.useQuery(undefined, { enabled: open, staleTime: 60_000 });
  const label = t("pages.desk.addIssue");
  return (
    <IssuePicker
      issues={visibleIssues(issues.data ?? [])}
      value={null}
      placeholder={t("pages.desk.addPlaceholder")}
      onOpenChange={setOpen}
      onChange={pick => {
        const row = issues.data?.find(i => i.key === pick.key && i.connectionId === pick.connectionId);
        if (!row) return;
        const pane: DeskPane = { connectionId: row.connectionId, key: row.key, remoteId: row.remoteId };
        announceAdd(desk, addPane(desk, pane), pane);
        change(d => addPane(d, pane));
        onAdded(paneId(pane));
      }}
    >
      {icon ? (
        <Button variant={variant} size="icon" className="size-touch shrink-0" aria-label={label} title={label}>
          <Plus className="h-4 w-4" aria-hidden />
        </Button>
      ) : (
        <Button variant={variant}>
          <Plus className="h-4 w-4" aria-hidden />
          {label}
        </Button>
      )}
    </IssuePicker>
  );
}
