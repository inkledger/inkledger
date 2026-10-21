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
