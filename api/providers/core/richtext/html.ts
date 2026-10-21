// HTML -> RichDoc with a small tolerant tokenizer (no DOM on the server).
// Pure, never throws. Scripts, styles and embeds are dropped with their content;
// only the attributes the tree needs (href, src, alt, class, type, checked) are read.

import { emptyDoc, plainText, type Block, type Inline, type ListItem, type RichDoc } from "@contracts/richtext";

type Image = Extract<Block, { t: "image" }>;
type Seg = Inline | Image;
type El = { tag: string; attrs: Record<string, string>; kids: Node[] };
type Node = string | El;

const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr", "param"]);
const RAW = new Set(["script", "style"]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "svg", "head", "title"]);
const BLOCKY = new Set(["p", "div", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "hr", "section", "article", "li"]);
const FLOW = new Set(["div", "section", "article", "main", "header", "footer", "aside", "nav", "figure", "figcaption", "details", "summary", "center", "form", "body", "html", "dl", "dt", "dd", "address", "fieldset"]);
const MAX_DEPTH = 256;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  copy: "©",
};

function decode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
    }
    return NAMED[body] ?? whole;
  });
}

// ---- tokenizer -> tree ----

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** HTML's implied end tags, the few that matter for text */
function autoClose(stack: El[], tag: string): void {
  const top = stack[stack.length - 1];
  if (top.tag === "p" && BLOCKY.has(tag)) {
    stack.pop();
    return;
  }
  const stops: Record<string, [Set<string>, Set<string>]> = {
    li: [new Set(["li"]), new Set(["ul", "ol"])],
    td: [new Set(["td", "th"]), new Set(["tr", "table"])],
    th: [new Set(["td", "th"]), new Set(["tr", "table"])],
    tr: [new Set(["tr"]), new Set(["table", "thead", "tbody", "tfoot"])],
    thead: [new Set(["thead", "tbody", "tfoot"]), new Set(["table"])],
    tbody: [new Set(["thead", "tbody", "tfoot"]), new Set(["table"])],
    tfoot: [new Set(["thead", "tbody", "tfoot"]), new Set(["table"])],
  };
  const rule = stops[tag];
  if (!rule) return;
  for (let k = stack.length - 1; k > 0; k--) {
    if (rule[0].has(stack[k].tag)) {
      stack.length = k;
      return;
    }
    if (rule[1].has(stack[k].tag)) return;
  }
}

function parseTree(html: string): El {
  const root: El = { tag: "#root", attrs: {}, kids: [] };
  const stack: El[] = [root];
  const n = html.length;
  const text = (s: string) => {
    if (s === "") return;
    const kids = stack[stack.length - 1].kids;
    const last = kids[kids.length - 1];
    const d = decode(s);
    if (typeof last === "string") kids[kids.length - 1] = last + d;
    else kids.push(d);
  };
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const e = html.indexOf("-->", i + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const e = html.indexOf(">", i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(html.slice(i, i + 4000));
    if (!m) {
      text("<");
      i++;
      continue;
    }
    i += m[0].length;
    const tag = m[2].toLowerCase();
    if (m[1] === "/") {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    autoClose(stack, tag);
    const el: El = { tag, attrs: parseAttrs(m[3]), kids: [] };
    stack[stack.length - 1].kids.push(el);
    if (RAW.has(tag)) {
      // the content is not markup: skip to the closing tag (or the end)
      const close = new RegExp(`</${tag}[\\s/>]`, "gi");
      close.lastIndex = i;
      const c = close.exec(html);
      const gt = c ? html.indexOf(">", c.index) : -1;
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (VOID.has(tag) || m[3].trimEnd().endsWith("/")) continue;
    if (stack.length < MAX_DEPTH) stack.push(el);
  }
  return root;
}

// ---- tree -> blocks ----

const collapse = (s: string): string => s.replace(/\s+/g, " ");
const blank = (x: Inline): boolean => x.t === "br" || (x.t === "text" && x.v.trim() === "");

function segsToInlines(segs: Seg[]): Inline[] {
  return segs.map((s): Inline => {
    if (s.t !== "image") return s;
    if (s.url) return { t: "link", url: s.url, c: [{ t: "text", v: s.alt ?? s.url }] };
    return { t: "attachment", name: s.name ?? "" };
  });
}

/** Merge neighbouring text, collapse spaces, trim at line edges */
function tidy(segs: Seg[]): Seg[] {
  const merged: Seg[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (s.t === "text" && last?.t === "text") merged[merged.length - 1] = { t: "text", v: collapse(last.v + s.v) };
    else merged.push(s);
  }
  const edge = (s: Seg | undefined): boolean => s === undefined || s.t === "br" || s.t === "image";
  return merged
    .map((s, k): Seg => {
      if (s.t !== "text") return s;
      let v = s.v;
      if (edge(merged[k - 1])) v = v.trimStart();
      if (edge(merged[k + 1])) v = v.trimEnd();
      return { t: "text", v };
    })
    .filter((s) => !(s.t === "text" && s.v === ""));
}

function trimBreaks(xs: Inline[]): Inline[] {
  let a = 0;
  let b = xs.length;
  while (a < b && blank(xs[a])) a++;
  while (b > a && blank(xs[b - 1])) b--;
  return xs.slice(a, b);
}

function segsToBlocks(segs: Seg[]): Block[] {
  const out: Block[] = [];
  let run: Inline[] = [];
  const flush = () => {
    if (!run.every(blank)) out.push({ t: "p", c: trimBreaks(run) });
    run = [];
  };
  for (const s of tidy(segs)) {
    if (s.t === "image") {
      flush();
      out.push(s);
    } else run.push(s);
  }
  flush();
  return out;
}

function textContent(nodes: Node[]): string {
  return nodes
    .map((x) => {
      if (typeof x === "string") return x;
      if (DROP.has(x.tag)) return "";
      return x.tag === "br" ? "\n" : textContent(x.kids);
    })
    .join("");
}

/** Inline-level content; block tags met here are transparent */
function inl(nodes: Node[]): Seg[] {
  return nodes.flatMap((x): Seg[] => {
    if (typeof x === "string") return [{ t: "text", v: collapse(x) }];
    if (DROP.has(x.tag)) return [];
    switch (x.tag) {
      case "br":
        return [{ t: "br" }];
      case "img": {
        const url = x.attrs.src;
        if (!url) return [];
        return [{ t: "image", url, ...(x.attrs.alt ? { alt: x.attrs.alt } : {}) }];
      }
      case "input":
        return [];
      case "strong":
      case "b":
        return [{ t: "strong", c: segsToInlines(tidy(inl(x.kids))) }];
      case "em":
      case "i":
        return [{ t: "em", c: segsToInlines(tidy(inl(x.kids))) }];
      case "s":
      case "del":
      case "strike":
        return [{ t: "strike", c: segsToInlines(tidy(inl(x.kids))) }];
      case "code":
      case "kbd":
      case "tt": {
        const v = collapse(textContent(x.kids));
        return v === "" ? [] : [{ t: "code", v }];
      }
      case "a": {
        const kids = segsToInlines(tidy(inl(x.kids)));
        const url = x.attrs.href;
        if (!url) return kids;
        return [{ t: "link", url, c: kids.length > 0 ? kids : [{ t: "text", v: url }] }];
      }
      default:
        return inl(x.kids);
    }
  });
}

const LANG = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/;

function codeBlock(el: El): Block {
  const inner = el.kids.find((k): k is El => typeof k !== "string" && k.tag === "code");
  const lang = LANG.exec(inner?.attrs.class ?? "")?.[1] ?? LANG.exec(el.attrs.class ?? "")?.[1];
  const v = textContent(el.kids).replace(/^\r?\n/, "").replace(/\n$/, "");
  return { t: "code", ...(lang ? { lang } : {}), v };
}

function findCheckbox(nodes: Node[], depth = 0): El | undefined {
  for (const x of nodes) {
    if (typeof x === "string") continue;
    if (x.tag === "input" && x.attrs.type?.toLowerCase() === "checkbox") return x;
    if (depth < 2 && (x.tag === "p" || x.tag === "label" || x.tag === "div" || x.tag === "span")) {
      const f = findCheckbox(x.kids, depth + 1);
      if (f) return f;
    }
  }
  return undefined;
}

function cellInlines(nodes: Node[]): Inline[] {
  return blocksOf(nodes).flatMap((b, k): Inline[] => {
    const sep: Inline[] = k > 0 ? [{ t: "br" }] : [];
    if (b.t === "p" || b.t === "h") return [...sep, ...b.c];
    const v = plainText({ v: 1, blocks: [b] });
    return v ? [...sep, { t: "text", v }] : [];
  });
}

function tableOf(el: El): Block {
  const rows: { cells: El[]; head: boolean }[] = [];
  const collect = (nodes: Node[], inHead: boolean) => {
    for (const x of nodes) {
      if (typeof x === "string") continue;
      if (x.tag === "tr") {
        const cells = x.kids.filter((c): c is El => typeof c !== "string" && (c.tag === "td" || c.tag === "th"));
        if (cells.length > 0) rows.push({ cells, head: inHead || cells.every((c) => c.tag === "th") });
      } else if (x.tag === "thead" || x.tag === "tbody" || x.tag === "tfoot") collect(x.kids, x.tag === "thead");
    }
  };
  collect(el.kids, false);
  return { t: "table", header: rows.length > 0 && rows[0].head, rows: rows.map((r) => r.cells.map((c) => cellInlines(c.kids))) };
}

function listOf(el: El): Block {
  const items: ListItem[] = el.kids
    .filter((x): x is El => typeof x !== "string" && x.tag === "li")
    .map((li) => {
      const box = findCheckbox(li.kids);
      return { checked: box ? "checked" in box.attrs : null, c: blocksOf(li.kids) };
    });
  return { t: "list", ordered: el.tag === "ol", items };
}

function blocksOf(nodes: Node[]): Block[] {
  const out: Block[] = [];
  let run: Seg[] = [];
  const flush = () => {
    out.push(...segsToBlocks(run));
    run = [];
  };
  const walk = (ns: Node[]) => {
    for (const x of ns) {
      if (typeof x === "string") {
        run.push({ t: "text", v: collapse(x) });
        continue;
      }
      if (DROP.has(x.tag)) continue;
      const tag = x.tag;
      if (tag === "p" || FLOW.has(tag)) {
        flush();
        walk(x.kids);
        flush();
      } else if (/^h[1-6]$/.test(tag)) {
        flush();
        out.push({ t: "h", level: Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6, c: trimBreaks(segsToInlines(tidy(inl(x.kids)))) });
      } else if (tag === "ul" || tag === "ol") {
        flush();
        out.push(listOf(x));
      } else if (tag === "pre") {
        flush();
        out.push(codeBlock(x));
      } else if (tag === "blockquote") {
        flush();
        out.push({ t: "quote", c: blocksOf(x.kids) });
      } else if (tag === "table") {
        flush();
        out.push(tableOf(x));
      } else if (tag === "hr") {
        flush();
        out.push({ t: "hr" });
      } else run.push(...inl([x]));
    }
  };
  walk(nodes);
  flush();
  return out;
}

export function fromHtml(html: string): RichDoc {
  try {
    if (typeof html !== "string" || html.trim() === "") return emptyDoc();
    return { v: 1, blocks: blocksOf(parseTree(html).kids) };
  } catch {
    return emptyDoc();
  }
}
