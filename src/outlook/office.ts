// What the Outlook pane uses of Office.js (loaded by outlook.html), typed.
// Only the open mail's headers are read: subject, sender, date, ids.

type OfficeMailItem = {
  itemId?: string;
  subject?: string;
  from?: { displayName?: string; emailAddress?: string } | null;
  sender?: { displayName?: string; emailAddress?: string } | null;
  dateTimeCreated?: Date;
  internetMessageId?: string;
};

type OfficeApi = {
  context: {
    displayLanguage?: string;
    roamingSettings: { get(name: string): unknown; set(name: string, value: string): void; saveAsync(done?: () => void): void };
    mailbox?: {
      item: OfficeMailItem | null;
      convertToRestId?(id: string, version: string): string;
      addHandlerAsync?(type: string, handler: () => void): void;
    };
  };
  MailboxEnums?: { RestVersion: { v2_0: string } };
  EventType?: { ItemChanged?: string };
  onReady(ready: () => void): void;
};

/** Office.js, when it loaded. */
export const office = (): OfficeApi | null => (globalThis as { Office?: OfficeApi }).Office ?? null;

const KEY = "inkledgerKey";
const FOLLOWED = "inkledgerFollowed";

/** Whether the pane has followed a mail change once (so it is pinned): the pin tip is not needed any more. */
export const hasFollowed = (): boolean => office()?.context.roamingSettings.get(FOLLOWED) === "1";
export const noteFollowed = (): Promise<void> =>
  new Promise(resolve => {
    const s = office()?.context.roamingSettings;
    if (!s || hasFollowed()) return resolve();
    s.set(FOLLOWED, "1");
    s.saveAsync(() => resolve());
  });

/** The add-in key, kept by Outlook for this mailbox (roaming settings). */
export const storedKey = (): string => {
  const v = office()?.context.roamingSettings.get(KEY);
  return typeof v === "string" ? v : "";
};
export const storeKey = (key: string): Promise<void> =>
  new Promise(resolve => {
    const s = office()?.context.roamingSettings;
    if (!s) return resolve();
    s.set(KEY, key);
    s.saveAsync(() => resolve());
  });

/** The open mail, as mails.pinTo takes it; null when none (or several) are selected. */
export type OpenMail = {
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: number | null;
  webLink: string;
  internetMessageId: string | null;
  exchangeId: string;
  source: "addin";
};

export function openMail(): OpenMail | null {
  const o = office();
  const item = o?.context.mailbox?.item;
  if (!o || !item?.itemId) return null;
  let rest = item.itemId;
  try {
    rest = o.context.mailbox?.convertToRestId?.(item.itemId, o.MailboxEnums?.RestVersion.v2_0 ?? "v2.0") ?? rest;
  } catch {
    // already in the REST form
  }
  rest = rest.replace(/\//g, "-").replace(/\+/g, "_");
  const from = item.from ?? item.sender ?? {};
  return {
    subject: (item.subject ?? "").trim().slice(0, 500),
    fromName: from.displayName || null,
    fromAddress: from.emailAddress || null,
    receivedAt: item.dateTimeCreated instanceof Date ? item.dateTimeCreated.getTime() : null,
    webLink: `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(rest)}`,
    internetMessageId: item.internetMessageId ? item.internetMessageId.replace(/^<|>$/g, "") : null,
    exchangeId: rest,
    source: "addin",
  };
}

/** Calls `changed` when another mail is selected (a pinned pane stays open). */
export function onMailChanged(changed: () => void): void {
  const o = office();
  const type = o?.EventType?.ItemChanged;
  if (type) o?.context.mailbox?.addHandlerAsync?.(type, changed);
}
