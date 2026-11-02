// Putting issues on the Desk from elsewhere in the app: an issue's page (its gestures, Shift-click
// on a link there), a list, the board, the sidebar. Loaded when first used: none of it is in the
// first load (the shell's Shift-click and drop hooks import it on demand).
import { toast } from "sonner";
import type { NavigateFunction } from "react-router";
import { deskIssues, DESK_MAX_PANES, sideBySide, type DeskLayout, type DeskPane } from "@contracts/desk";
import { parseIssuePath, type IssueLinkRef } from "@/lib/issues";
import { toastError } from "@/lib/errorText";
import type { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

export type Utils = ReturnType<typeof trpc.useUtils>;
type Context = { utils: Utils; navigate: NavigateFunction };

/** On the Desk, an issue to open there (Shift-click): the Desk page takes it into its own desk. */
export const DESK_OPEN_EVENT = "inkledger:desk-open";
export type DeskOpenDetail = IssueLinkRef;

/** The issue a link names, as a pane: found in the catalogue, else by its key on the connection named (null when neither says which). */
export async function paneOf(utils: Utils, ref: IssueLinkRef): Promise<DeskPane | null> {
  const found = await utils.issues.locate.fetch(ref, { staleTime: 60_000 });
  if (found && !("ambiguous" in found)) return { connectionId: found.connectionId, key: found.key, remoteId: found.remoteId };
  return "key" in ref && ref.connectionId ? { connectionId: ref.connectionId, key: ref.key, remoteId: null } : null;
}

/** The desk changed by `fn`, saved, then shown. */
export async function sendToDesk({ utils, navigate }: Context, fn: (desk: DeskLayout) => DeskLayout) {
  try {
    const before = await utils.desks.current.fetch(undefined, { staleTime: 0 });
    const layout = await utils.client.desks.setCurrent.mutate({ layout: fn(before) });
    utils.desks.current.setData(undefined, layout);
    await navigate("/issues/desk");
  } catch (e) {
    toastError(e);
  }
}

/** An issue put on the desk from a page that isn't the desk: said in a toast ("2/6"), with the way to the desk. */
export async function addToDesk({ utils, navigate }: Context, ref: IssueLinkRef) {
  try {
    const r = await utils.client.desks.add.mutate(ref);
    utils.desks.current.setData(undefined, r.layout);
    const message = r.already
      ? t("pages.desk.already", { key: r.key })
      : r.parked
        ? t("pages.desk.addedParked", { key: r.key, parked: r.parked })
        : t("pages.desk.added", { key: r.key, count: deskIssues(r.layout).length, max: DESK_MAX_PANES });
    toast(message, { action: { label: t("ui.palette.openDesk"), onClick: () => void navigate("/issues/desk") } });
  } catch (e) {
    toastError(e);
  }
}

/**
 * "Open beside" (Shift-click on an issue link, the menus' item): on the Desk, into its first empty
 * slot; on an issue's page, the Desk with the two side by side; anywhere else, added to the desk.
 */
export async function openBeside(ref: IssueLinkRef, { pathname, search, ...context }: Context & { pathname: string; search: string }) {
  if (/^\/issues\/desk\/?$/.test(pathname)) {
    window.dispatchEvent(new CustomEvent<DeskOpenDetail>(DESK_OPEN_EVENT, { detail: ref }));
    return;
  }
  const here = parseIssuePath(pathname + search);
  if (here) {
    const [current, other] = await Promise.all([paneOf(context.utils, here), paneOf(context.utils, ref)]).catch(() => [null, null]);
    if (current && other) return sendToDesk(context, desk => sideBySide(desk, current, other));
  }
  return addToDesk(context, ref);
}
