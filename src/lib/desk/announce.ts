import { toast } from "sonner";
import { DESK_MAX_PANES, paneId, type DeskLayout, type DeskPane } from "@contracts/desk";
import { t } from "@/i18n";

/** What adding an issue did, said in a toast: already there, added (n/4), or added with the last pane parked. */
export function announceAdd(before: DeskLayout, after: DeskLayout, pane: DeskPane) {
  const id = paneId(pane);
  if (before.panes.some(item => paneId(item) === id)) return toast(t("pages.desk.already", { key: pane.key }));
  const out = before.panes.length >= DESK_MAX_PANES ? before.panes[before.panes.length - 1] : undefined;
  if (out && after.parked.some(item => paneId(item) === paneId(out))) return toast(t("pages.desk.addedParked", { key: pane.key, parked: out.key }));
  toast(t("pages.desk.added", { key: pane.key, count: after.panes.length }));
}
