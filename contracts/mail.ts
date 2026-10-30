import { z } from "zod";
import { instant, type Instant } from "./values";

/**
 * Pinned mails: what is read from an Outlook link or a dropped .eml file:
 * headers. The body only in a copy the user chose to keep, sealed on the
 * server (docs/work/ideas/mail-copies.md; "never the body" until 2026-10-30).
 */

/** Where a pinned mail came from. */
export const MAIL_SOURCES = ["link", "eml", "addin", "graph"] as const;
export type MailSource = (typeof MAIL_SOURCES)[number];

/** Outlook on the web, for work (office.com, office365.com, cloud.microsoft) and personal (live.com) accounts. */
const OUTLOOK_HOSTS = ["outlook.office.com", "outlook.office365.com", "outlook.cloud.microsoft", "outlook.live.com"] as const;

/** An Exchange item id: base64, plain or URL-safe, sometimes percent-encoded twice. */
const ITEM_ID_RE = /^[A-Za-z0-9+/_=-]{20,}$/;

/** A message's id and the link that opens it, read from an Outlook web address. */
export type OutlookLink = { itemId: string; webLink: string };

function decode(segment: string): string {
  let v = segment;
  // Outlook encodes the id once or twice ("%253D").
  for (let i = 0; i < 2 && /%[0-9A-Fa-f]{2}/.test(v); i++) {
    try {
      v = decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** The REST form of an id (the one Outlook's own links use): EWS "/" and "+" become "-" and "_". */
export const restItemId = (id: string): string => id.replace(/\//g, "-").replace(/\+/g, "_");

/**
 * Reads the message an Outlook web address opens:
 * `/mail/{folder…}/id/{id}`, `/mail/deeplink/read/{id}` and the older `/owa/?ItemID={id}`.
 * The link comes back in the stable deeplink form; null when it is not a message link.
 */
export function parseOutlookUrl(raw: string): OutlookLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(OUTLOOK_HOSTS as readonly string[]).includes(host)) return null;

  let id: string | null = null;
  const path = url.pathname.split("/").filter(Boolean);
  const at = path.findIndex((s, i) => (s === "id" && path[0] === "mail") || (s === "read" && path[i - 1] === "deeplink"));
  if (at >= 0 && path[at + 1]) id = decode(path[at + 1]);
  else if (path[0]?.toLowerCase() === "owa") id = url.searchParams.get("ItemID") ?? url.searchParams.get("itemid");
  if (!id || !ITEM_ID_RE.test(id)) return null;

  const itemId = restItemId(id);
  // The legacy /owa host serves the new links on outlook.office.com.
  const base = host === "outlook.office365.com" ? "outlook.office.com" : host;
  return { itemId, webLink: outlookDeeplink(itemId, base) };
}

/** The link that opens a message (its REST id) in Outlook on the web: a work account's unless told. */
export const outlookDeeplink = (restId: string, host = "outlook.office.com"): string =>
  `https://${host}/mail/deeplink/read/${encodeURIComponent(restItemId(restId))}`;

/** What is kept of a mail. */
export type MailHeaders = {
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: Instant | null;
  /** The Message-ID header, without its angle brackets: the same mail everywhere. */
  internetMessageId: string | null;
};

/** The header block of an RFC 5322 message, unfolded, keyed in lower case (first occurrence wins). */
function headerBlock(text: string): Map<string, string> {
  const end = text.search(/\r?\n\r?\n/);
  const block = (end < 0 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const out = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!out.has(key)) out.set(key, line.slice(colon + 1).trim());
  }
  return out;
}

function bytesOf(text: string, encoding: string): Uint8Array {
  if (encoding.toUpperCase() === "B") {
    const bin = atob(text.replace(/[^A-Za-z0-9+/=]/g, ""));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  }
  // Q: "_" is a space, "=XX" a byte.
  const out: number[] = [];
  const s = text.replace(/_/g, " ");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

/** Decodes RFC 2047 encoded words ("=?UTF-8?B?…?="); the space between two of them goes. */
export function decodeWords(value: string): string {
  const word = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  return value.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1").replace(word, (all, charset: string, enc: string, data: string) => {
    try {
      return new TextDecoder(charset.replace(/\*.*$/, "").toLowerCase()).decode(bytesOf(data, enc));
    } catch {
      return all;
    }
  });
}

/** `"Name" <a@b>`, `Name <a@b>` or `a@b` → name and address. */
export function parseAddress(value: string): { name: string | null; address: string | null } {
  const v = decodeWords(value).trim();
  const angle = v.match(/^(.*?)<([^<>@\s]+@[^<>\s]+)>\s*$/);
  if (angle) {
    const name = angle[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
    return { name: name || null, address: angle[2].toLowerCase() };
  }
  const bare = v.match(/^[^<>@\s]+@[^<>\s]+$/);
  return bare ? { name: null, address: v.toLowerCase() } : { name: v || null, address: null };
}

/** The Message-ID without "<" ">"; null when there is none. */
export const messageId = (value: string | undefined): string | null => {
  const v = value?.trim().replace(/^<|>$/g, "").trim();
  return v ? v : null;
};

/**
 * The headers of a dropped .eml file (only its header block is read). Null when
 * the text has none of Subject, From or Message-ID: not a mail.
 */
export function parseEmlHeaders(text: string): MailHeaders | null {
  const h = headerBlock(text);
  if (!h.has("subject") && !h.has("from") && !h.has("message-id")) return null;
  const from = h.has("from") ? parseAddress(h.get("from") ?? "") : { name: null, address: null };
  const at = Date.parse(h.get("date") ?? "");
  return {
    subject: decodeWords(h.get("subject") ?? "").trim(),
    fromName: from.name,
    fromAddress: from.address,
    receivedAt: Number.isFinite(at) && at >= 0 ? instant(at) : null,
    internetMessageId: messageId(h.get("message-id")),
  };
}

/** A copy in "body" mode (R-1.3): what the mail said and showed, the attachments by name only. */
export const mailCopyBodySchema = z.object({
  v: z.literal(1),
  headers: z.object({
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    date: z.string().nullable(),
    subject: z.string(),
  }),
  text: z.string(),
  html: z.string().nullable(),
  attachments: z.array(z.object({ name: z.string(), type: z.string(), size: z.number().int().nonnegative() })),
});
export type MailCopyBody = z.infer<typeof mailCopyBodySchema>;
export const MAIL_COPY_MODES = ["off", "body", "full"] as const;
export type MailCopyMode = (typeof MAIL_COPY_MODES)[number];
