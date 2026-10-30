// Rich text as the app shows it, whatever a tracker writes it in (ADF, Jira
// wiki, GitHub/GitLab Markdown, HTML…): one small tree, built on the server
// by api/providers/core/richtext and drawn by one safe renderer. Links and
// images carry their raw target: the renderer decides what may be opened or
// loaded (http(s)/mailto only; images only through the attachment proxy).

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "strike"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; url: string; c: Inline[] }
  /** Someone named in the text: their name as written, their id on the service when known */
  | { t: "mention"; name: string; id?: string }
  /** An emoji: the character when known, else its short name (":smile:") */
  | { t: "emoji"; v: string }
  /** A file attached to the issue, named in the text (not an image) */
  | { t: "attachment"; name: string }
  | { t: "br" };

export type ListItem = { checked: boolean | null; c: Block[] };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "code"; lang?: string; v: string }
  | { t: "list"; ordered: boolean; items: ListItem[] }
  | { t: "quote"; c: Block[] }
  /** Rows of cells; the first row is a header when `header` */
  | { t: "table"; header: boolean; rows: Inline[][][] }
  | { t: "hr" }
  /** An image: an attachment of the issue by its file name, or an address elsewhere (never loaded by the app) */
  | { t: "image"; name?: string; url?: string; alt?: string }
  /** A panel or callout (Jira {panel}/{info}, ADF panel, GitHub > [!NOTE]) */
  | { t: "panel"; kind: "info" | "note" | "warning" | "success" | "error"; c: Block[] };

export type RichDoc = { v: 1; blocks: Block[] };

export const emptyDoc = (): RichDoc => ({ v: 1, blocks: [] });

const inlineText = (xs: Inline[]): string =>
  xs
    .map((x) => {
      switch (x.t) {
        case "text":
        case "code":
        case "emoji":
          return x.v;
        case "strong":
        case "em":
        case "strike":
        case "link":
          return inlineText(x.c);
        case "mention":
          return `@${x.name}`;
        case "attachment":
          return x.name;
        case "br":
          return "\n";
      }
    })
    .join("");

const blockText = (b: Block): string => {
  switch (b.t) {
    case "p":
    case "h":
      return inlineText(b.c);
    case "code":
      return b.v;
    case "list":
      return b.items.map((i) => i.c.map(blockText).join("\n")).join("\n");
    case "quote":
    case "panel":
      return b.c.map(blockText).join("\n");
    case "table":
      return b.rows.map((r) => r.map(inlineText).join("\t")).join("\n");
    case "hr":
      return "";
    case "image":
      return b.alt ?? b.name ?? "";
  }
};

/** The words of a document, for previews, search and notices. */
export function plainText(doc: RichDoc): string {
  return doc.blocks.map(blockText).filter(Boolean).join("\n\n").trim();
}

/**
 * The document with its outside addresses (images by URL, links) passed
 * through `to`: a replacement, or null to keep the address as it is.
 */
export function mapUrls(doc: RichDoc, to: (url: string) => string | null): RichDoc {
  const inl = (xs: Inline[]): Inline[] =>
    xs.map((x) => {
      switch (x.t) {
        case "strong":
        case "em":
        case "strike":
          return { ...x, c: inl(x.c) };
        case "link":
          return { ...x, url: to(x.url) ?? x.url, c: inl(x.c) };
        default:
          return x;
      }
    });
  const blk = (b: Block): Block => {
    switch (b.t) {
      case "p":
      case "h":
        return { ...b, c: inl(b.c) };
      case "list":
        return { ...b, items: b.items.map((i) => ({ ...i, c: i.c.map(blk) })) };
      case "quote":
      case "panel":
        return { ...b, c: b.c.map(blk) };
      case "table":
        return { ...b, rows: b.rows.map((r) => r.map(inl)) };
      case "image":
        return b.url ? { ...b, url: to(b.url) ?? b.url } : b;
      default:
        return b;
    }
  };
  return { ...doc, blocks: doc.blocks.map(blk) };
}

// ── Markdown, for an agent (docs/work/ideas/issue-copy.md R-6.2) ──

/** Text as Markdown reads it literally: the characters that would format are escaped. */
export const escapeMd = (s: string): string => s.replace(/[\\`*_[\]<>]/g, "\\$&");

/** A line that would start a heading, quote, list or rule is escaped at its start. */
const escapeLineStarts = (s: string): string =>
  s
    .split("\n")
    .map((line) => line.replace(/^(\s*)([#>+-])/, "$1\\$2").replace(/^(\s*\d+)([.)])/, "$1\\$2"))
    .join("\n");

/** The longest run of backticks in a string. */
const longestTicks = (s: string): number => Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length));

/** A target Markdown keeps whole: spaces and parentheses would end it. */
const mdUrl = (url: string): string => url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");

const PANEL_LABEL: Record<Extract<Block, { t: "panel" }>["kind"], string> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  success: "Success",
  error: "Error",
};

/** Resolves an attachment of the issue, by its file name, to a link an agent can open; null when there is none. */
export type AttachmentLink = (name: string) => string | null;

const inlineMd = (xs: Inline[], link: AttachmentLink): string =>
  xs
    .map((x): string => {
      switch (x.t) {
        case "text":
          return escapeMd(x.v);
        case "strong":
          return `**${inlineMd(x.c, link)}**`;
        case "em":
          return `*${inlineMd(x.c, link)}*`;
        case "strike":
          return `~~${inlineMd(x.c, link)}~~`;
        case "code": {
          const n = longestTicks(x.v);
          if (n === 0) return `\`${x.v}\``;
          const fence = "`".repeat(n + 1);
          return `${fence} ${x.v} ${fence}`;
        }
        case "link":
          return `[${inlineMd(x.c, link)}](${mdUrl(x.url)})`;
        case "mention":
          return `@${escapeMd(x.name)}`;
        case "emoji":
          return x.v;
        case "attachment": {
          const url = link(x.name);
          return url ? `[${escapeMd(x.name)}](${mdUrl(url)})` : `[attachment: ${escapeMd(x.name)}]`;
        }
        case "br":
          return "  \n";
      }
    })
    .join("");

const indent = (s: string, by: string): string =>
  s
    .split("\n")
    .map((line) => (line ? by + line : line))
    .join("\n");

const quoted = (s: string): string =>
  s
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");

const cellMd = (c: Inline[], link: AttachmentLink): string => inlineMd(c, link).replace(/ {2}\n/g, " ").replace(/\|/g, "\\|");

const blockMd = (b: Block, link: AttachmentLink): string => {
  switch (b.t) {
    case "p":
      return escapeLineStarts(inlineMd(b.c, link));
    case "h":
      return `${"#".repeat(b.level)} ${inlineMd(b.c, link)}`;
    case "code": {
      const fence = "`".repeat(Math.max(3, longestTicks(b.v) + 1));
      return `${fence}${b.lang ?? ""}\n${b.v}\n${fence}`;
    }
    case "list":
      return b.items
        .map((item, i) => {
          const marker = b.ordered ? `${i + 1}. ` : "- ";
          const box = item.checked === null ? "" : item.checked ? "[x] " : "[ ] ";
          const [first = "", ...rest] = item.c.map((c) => blockMd(c, link));
          const pad = " ".repeat(marker.length);
          return [marker + box + indent(first, pad).slice(pad.length), ...rest.map((r) => indent(r, pad))].join("\n");
        })
        .join("\n");
    case "quote":
      return quoted(blocksMd(b.c, link));
    case "table": {
      const width = Math.max(1, ...b.rows.map((r) => r.length));
      const row = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
      const rows = b.rows.map((r) => r.map((c) => cellMd(c, link)));
      const [head, ...body] = b.header ? rows : [[], ...rows];
      return [row(head ?? []), row(Array.from({ length: width }, () => "---")), ...body.map(row)].join("\n");
    }
    case "hr":
      return "---";
    case "image": {
      if (b.name !== undefined) {
        const url = link(b.name);
        return url ? `![${escapeMd(b.alt ?? b.name)}](${mdUrl(url)})` : `[attachment: ${escapeMd(b.name)}]`;
      }
      return b.url ? `![${escapeMd(b.alt ?? "")}](${mdUrl(b.url)})` : "";
    }
    case "panel":
      return quoted(`**${PANEL_LABEL[b.kind]}:**\n${blocksMd(b.c, link)}`);
  }
};

const blocksMd = (bs: Block[], link: AttachmentLink): string =>
  bs
    .map((b) => blockMd(b, link))
    .filter(Boolean)
    .join("\n\n");

/** A document as Markdown, attachments linked through `link` (an agent reads it pasted). */
export function toMarkdown(doc: RichDoc, link: AttachmentLink): string {
  return blocksMd(doc.blocks, link);
}
