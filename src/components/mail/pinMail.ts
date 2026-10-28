import { pinMailDialog } from "@/lib/flag";
import type { MailDraft } from "./readMail";

/** What the "Pin a mail" dialog opens with: a mail read from a drop or a paste, or words to search the mailbox for. */
export type PinMailStart = { draft?: MailDraft | null; query?: string };

let pending: PinMailStart = {};

/** Opens "Pin a mail" from anywhere (it then asks where the mail goes). */
export function openPinMail(start: PinMailStart = {}): void {
  pending = start;
  pinMailDialog.set(true);
}

/** The start the dialog was opened with, once. */
export function takePinMailStart(): PinMailStart {
  const s = pending;
  pending = {};
  return s;
}
