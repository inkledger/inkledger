import { parseEmlHeaders, parseOutlookUrl, type MailHeaders, type MailSource } from "@contracts/mail";

/** What a pasted text, a dropped file or the mailbox says about a mail, ready for mails.save. */
export type MailDraft = {
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: number | null;
  webLink: string | null;
  internetMessageId: string | null;
  exchangeId: string | null;
  source: MailSource;
};

/** Headers are at the top: a few KB are plenty, and the body is never read. */
const HEAD_BYTES = 64 * 1024;

const fromHeaders = (h: MailHeaders): MailDraft => ({ ...h, webLink: null, exchangeId: null, source: "eml" });

/** A pasted Outlook link (null when the text is not one). */
export function draftFromLink(text: string): MailDraft | null {
  const link = parseOutlookUrl(text);
  if (!link) return null;
  return {
    subject: "",
    fromName: null,
    fromAddress: null,
    receivedAt: null,
    webLink: link.webLink,
    internetMessageId: null,
    exchangeId: link.itemId,
    source: "link",
  };
}

/** The file a draft was read from: sent whole only when the user keeps copies (docs/work/ideas/mail-copies.md R-1.6). */
const files = new WeakMap<MailDraft, File>();
export const fileOf = (draft: MailDraft | null | undefined): File | undefined => (draft ? files.get(draft) : undefined);

/** A dropped or picked .eml file (null when it is not a mail): only its headers are read here. */
export async function draftFromFile(file: File): Promise<MailDraft | null> {
  const head = await file.slice(0, HEAD_BYTES).text();
  const h = parseEmlHeaders(head);
  if (!h) return null;
  const draft = fromHeaders(h);
  files.set(draft, file);
  return draft;
}

/** What a drop carries: an .eml file, else an Outlook link dragged from the browser. */
export async function draftFromDrop(data: DataTransfer): Promise<MailDraft | null> {
  const file = Array.from(data.files).find(f => /\.eml$/i.test(f.name) || f.type === "message/rfc822");
  if (file) return draftFromFile(file);
  const text = data.getData("text/uri-list") || data.getData("text/plain");
  return text ? draftFromLink(text.split(/\r?\n/).find(l => l && !l.startsWith("#")) ?? "") : null;
}

/** Whether a drag may carry a mail (checked before its content can be read). */
export const mayCarryMail = (data: DataTransfer): boolean =>
  Array.from(data.types).some(t => t === "Files" || t === "text/uri-list" || t === "text/plain");
