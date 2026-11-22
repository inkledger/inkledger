import { pinMailDialog } from "@/lib/flag";
import { ISSUE_DRAG_TYPE } from "@/lib/issues";
import type { MailDraft } from "./readMail";

/** What the "Pin a mail" dialog opens with: a mail read from a drop or a paste, or words to search the mailbox for. */
export type PinMailStart = { draft?: MailDraft | null; query?: string };

let pending: PinMailStart = {};

/** Opens "Pin a mail" from anywhere (it then asks where the mail goes). */
export function openPinMail(start: PinMailStart = {}): void {
  pending = start;
  pinMailDialog.set(true);
}

/** What a drag may bring from outside: a file, a link or words. An issue dragged within the app (it carries its key as text) never. */
export const mayBeMail = (types: readonly string[]) =>
  !types.includes(ISSUE_DRAG_TYPE) && types.some(t => t === "Files" || t === "text/uri-list" || t === "text/plain");

/** The start the dialog was opened with, once. */
export function takePinMailStart(): PinMailStart {
  const s = pending;
  pending = {};
  return s;
}
