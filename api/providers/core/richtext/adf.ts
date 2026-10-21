// Atlassian Document Format -> RichDoc. Lenient: unknown nodes keep their text,
// malformed input gives an empty document, nothing throws.

import { emptyDoc, type Block, type Inline, type ListItem, type RichDoc } from "@contracts/richtext";

type Node = Record<string, unknown>;

const isNode = (x: unknown): x is Node => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" && x !== "" ? x : undefined);
const kids = (n: Node): Node[] => (Array.isArray(n.content) ? (n.content as unknown[]).filter(isNode) : []);
const attrs = (n: Node): Node => (isNode(n.attrs) ? n.attrs : {});

const INLINE_TYPES = new Set(["text", "hardBreak", "mention", "emoji", "inlineCard", "status", "date", "mediaInline", "inlineExtension"]);
const PANELS: Record<string, "info" | "note" | "warning" | "success" | "error"> = {
  info: "info",
  note: "note",
  warning: "warning",
  success: "success",
  error: "error",
};

/** All the text under a node, whatever it is */
function textOf(n: Node): string {
  if (n.type === "hardBreak") return "\n";
  const own = typeof n.text === "string" ? n.text : "";
  return own + kids(n).map(textOf).join("");
}

function isoDate(ts: unknown): string {
  const ms = typeof ts === "number" ? ts : typeof ts === "string" ? Number(ts) : NaN;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function withMarks(base: Inline, marks: unknown): Inline {
  if (!Array.isArray(marks)) return base;
  return (marks as unknown[]).filter(isNode).reduce<Inline>((acc, m) => {
    switch (m.type) {
      case "strong":
        return { t: "strong", c: [acc] };
      case "em":
        return { t: "em", c: [acc] };
      case "strike":
        return { t: "strike", c: [acc] };
      case "link": {
        const href = str(attrs(m).href);
        return href ? { t: "link", url: href, c: [acc] } : acc;
      }
      default:
        return acc; // code is the base, underline/subsup/textColor keep the text
    }
  }, base);
}

function inlineNode(n: Node): Inline[] {
  const a = attrs(n);
  switch (n.type) {
    case "text": {
      const v = typeof n.text === "string" ? n.text : "";
      if (v === "") return [];
      const marks = Array.isArray(n.marks) ? (n.marks as unknown[]).filter(isNode) : [];
      const base: Inline = marks.some((m) => m.type === "code") ? { t: "code", v } : { t: "text", v };
      return [withMarks(base, marks)];
    }
    case "hardBreak":
      return [{ t: "br" }];
    case "mention": {
      const name = (str(a.text) ?? str(a.id) ?? "").replace(/^@/, "");
      return name ? [{ t: "mention", name, ...(str(a.id) ? { id: str(a.id) } : {}) }] : [];
    }
    case "emoji": {
      const v = str(a.text) ?? str(a.shortName);
      return v ? [{ t: "emoji", v }] : [];
    }
    case "inlineCard":
    case "blockCard": {
      const url = str(a.url);
      return url ? [{ t: "link", url, c: [{ t: "text", v: url }] }] : [];
    }
    case "status": {
      const v = str(a.text);
      return v ? [{ t: "code", v }] : [];
    }
    case "date": {
      const v = isoDate(a.timestamp);
      return v ? [{ t: "text", v }] : [];
    }
    case "mediaInline": {
      const name = str(a.alt) ?? str(a.id);
      return name ? [{ t: "attachment", name }] : [];
    }
    default:
      return inlines(kids(n)).concat(typeof n.text === "string" && n.text ? [{ t: "text", v: n.text }] : []);
  }
}

function inlines(nodes: Node[]): Inline[] {
  return nodes.flatMap(inlineNode);
}

/** Blocks flattened to inlines (table cells): paragraphs joined by a break */
function flatten(bs: Block[]): Inline[] {
  return bs.flatMap((b, i): Inline[] => {
    const sep: Inline[] = i > 0 ? [{ t: "br" }] : [];
    switch (b.t) {
      case "p":
      case "h":
        return [...sep, ...b.c];
      case "code":
        return [...sep, { t: "code", v: b.v }];
      case "image": {
        const v = b.alt ?? b.name ?? b.url;
        return v ? [...sep, { t: "text", v }] : [];
      }
      case "hr":
        return [];
      case "list":
        return [...sep, ...b.items.flatMap((it, k) => [...(k > 0 ? [{ t: "br" } as const] : []), ...flatten(it.c)])];
      case "quote":
      case "panel":
        return [...sep, ...flatten(b.c)];
      case "table":
        return [...sep, ...b.rows.flatMap((r) => r.flatMap((c) => c))];
    }
  });
}

/** Children that may mix inline and block nodes (taskItem, decisionItem, unknown containers) */
function flow(nodes: Node[]): Block[] {
  const out: Block[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const c = inlines(run);
    if (c.length > 0) out.push({ t: "p", c });
    run = [];
  };
  for (const n of nodes) {
    if (typeof n.type === "string" && INLINE_TYPES.has(n.type)) run.push(n);
    else {
      flush();
      out.push(...blockNode(n));
    }
  }
  flush();
  return out;
}

function mediaBlock(n: Node): Block[] {
  const a = attrs(n);
  if (n.type !== "media") return flow(kids(n)).flatMap((b) => (b.t === "image" ? [b] : []));
  if (a.type === "external") {
    const url = str(a.url);
    return url ? [{ t: "image", url, ...(str(a.alt) ? { alt: str(a.alt) } : {}) }] : [];
  }
  const name = str(a.alt) ?? str(a.id);
  return name ? [{ t: "image", name }] : [];
}

function listItems(nodes: Node[], task: boolean): ListItem[] {
  return nodes.map((it) => ({
    checked: task ? attrs(it).state === "DONE" : null,
    c: flow(kids(it)),
  }));
}

function blockNode(n: Node): Block[] {
  const a = attrs(n);
  switch (n.type) {
    case "paragraph": {
      const c = inlines(kids(n));
      return c.length > 0 ? [{ t: "p", c }] : [];
    }
    case "heading": {
      const lv = typeof a.level === "number" ? Math.min(6, Math.max(1, Math.round(a.level))) : 1;
      return [{ t: "h", level: lv as 1 | 2 | 3 | 4 | 5 | 6, c: inlines(kids(n)) }];
    }
    case "bulletList":
    case "orderedList":
      return [{ t: "list", ordered: n.type === "orderedList", items: listItems(kids(n), false) }];
    case "taskList":
      return [{ t: "list", ordered: false, items: listItems(kids(n), true) }];
    case "decisionList":
      return [{ t: "list", ordered: false, items: listItems(kids(n), false) }];
    case "codeBlock":
      return [{ t: "code", ...(str(a.language) ? { lang: str(a.language) } : {}), v: textOf(n) }];
    case "blockquote":
      return [{ t: "quote", c: flow(kids(n)) }];
    case "rule":
      return [{ t: "hr" }];
    case "table": {
      const rowNodes = kids(n).filter((r) => r.type === "tableRow");
      const rows = rowNodes.map((r) => kids(r).map((cell) => flatten(flow(kids(cell)))));
      const header = rowNodes.length > 0 && kids(rowNodes[0]).length > 0 && kids(rowNodes[0]).every((c) => c.type === "tableHeader");
      return [{ t: "table", header, rows }];
    }
    case "panel": {
      const kind = PANELS[str(a.panelType) ?? "info"] ?? "info";
      return [{ t: "panel", kind, c: flow(kids(n)) }];
    }
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return mediaBlock(n);
    case "expand":
    case "nestedExpand": {
      const title = str(a.title);
      const head: Block[] = title ? [{ t: "p", c: [{ t: "strong", c: [{ t: "text", v: title }] }] }] : [];
      return [...head, ...flow(kids(n))];
    }
    case "blockCard": {
      const c = inlineNode(n);
      return c.length > 0 ? [{ t: "p", c }] : [];
    }
    default: {
      if (typeof n.type === "string" && INLINE_TYPES.has(n.type)) {
        const c = inlineNode(n);
        return c.length > 0 ? [{ t: "p", c }] : [];
      }
      // unknown node: keep what it holds
      const inner = kids(n);
      if (inner.length > 0) return flow(inner);
      const v = typeof n.text === "string" ? n.text : "";
      return v ? [{ t: "p", c: [{ t: "text", v }] }] : [];
    }
  }
}

export function fromAdf(doc: unknown): RichDoc {
  try {
    if (!isNode(doc)) return emptyDoc();
    if (doc.type === "doc" || Array.isArray(doc.content)) return { v: 1, blocks: flow(kids(doc)) };
    return { v: 1, blocks: blockNode(doc) };
  } catch {
    return emptyDoc();
  }
}
