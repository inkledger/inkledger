// Jira wiki markup -> RichDoc. Line-based blocks, a scanner for inlines.
// Pure, never throws; unknown markup stays as text.

import { emptyDoc, type Block, type Inline, type ListItem, type RichDoc } from "@contracts/richtext";

type Image = Extract<Block, { t: "image" }>;
type Seg = Inline | Image;
type Panel = Extract<Block, { t: "panel" }>["kind"];

// how far an emphasis marker looks for its partner (keeps scanning linear-ish)
const REACH = 4000;

const EMOJI: Record<string, string> = {
  ":)": "\u{1F642}",
  ":(": "\u{1F641}",
  ";)": "\u{1F609}",
  ":D": "\u{1F603}",
  ":P": "\u{1F61B}",
  "(/)": "✅",
  "(x)": "❌",
  "(!)": "⚠️",
  "(i)": "ℹ️",
  "(y)": "\u{1F44D}",
  "(n)": "\u{1F44E}",
  "(?)": "❓",
};

const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

// ---- inlines ----

/** Images split a paragraph; elsewhere they fall back to a link or an attachment */
function segsToInlines(segs: Seg[]): Inline[] {
  return segs.map((s): Inline => {
    if (s.t !== "image") return s;
    if (s.url) return { t: "link", url: s.url, c: [{ t: "text", v: s.alt ?? s.url }] };
    return { t: "attachment", name: s.name ?? "" };
  });
}

function segsToBlocks(segs: Seg[]): Block[] {
  const out: Block[] = [];
  let run: Inline[] = [];
  const flush = () => {
    if (!run.every(blank)) out.push({ t: "p", c: trimBreaks(run) });
    run = [];
  };
  for (const s of segs) {
    if (s.t === "image") {
      flush();
      out.push(s);
    } else run.push(s);
  }
  flush();
  return out;
}

const blank = (x: Inline): boolean => x.t === "br" || (x.t === "text" && x.v.trim() === "");

function trimBreaks(xs: Inline[]): Inline[] {
  let a = 0;
  let b = xs.length;
  while (a < b && blank(xs[a])) a++;
  while (b > a && blank(xs[b - 1])) b--;
  return xs.slice(a, b);
}

/** Index of the closing marker for a span opened at `from`, or -1 */
function closer(s: string, from: number, ch: string): number {
  const end = Math.min(s.length, from + REACH);
  for (let j = from; j < end; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === ch && !isSpace(s[j - 1]) && !isAlnum(s[j + 1]) && j > from) return j;
  }
  return -1;
}

const SPAN: Record<string, "strong" | "em" | "strike" | "plain"> = { "*": "strong", _: "em", "-": "strike", "+": "plain", "?": "em" };
const ESCAPABLE = "*_-+{}[]!|^~?()\\#";

function urlEnd(s: string, from: number): number {
  let j = from;
  while (j < s.length && !/[\s<>"|\]]/.test(s[j])) j++;
  while (j > from && /[.,;:!?]/.test(s[j - 1])) j--;
  if (j > from && s[j - 1] === ")" && !s.slice(from, j).includes("(")) j--;
  return j;
}

const isUrl = (s: string): boolean => /^(https?:\/\/|mailto:)\S+$/i.test(s);

function image(inner: string): Image | null {
  const [file] = inner.split("|");
  if (!file || /\s/.test(file)) return null;
  return /^https?:\/\//i.test(file) ? { t: "image", url: file } : { t: "image", name: file };
}

function parseInline(s: string): Seg[] {
  const out: Seg[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const prev = s[i - 1];
    // line break
    if (c === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (c === "\\") {
      if (s[i + 1] === "\\") {
        flush();
        out.push({ t: "br" });
        i += 2;
        continue;
      }
      if (i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
    }
    if (c === "{") {
      if (s.startsWith("{{", i)) {
        const e = s.indexOf("}}", i + 2);
        if (e > i + 2 && e - i < REACH) {
          flush();
          out.push({ t: "code", v: s.slice(i + 2, e) });
          i = e + 2;
          continue;
        }
      }
      const m = /^\{color(?::[^}\n]*)?\}/.exec(s.slice(i, i + 64));
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      const e = s.indexOf("]", i + 1);
      if (e > i && e - i < 1000) {
        const inner = s.slice(i + 1, e);
        if (inner.startsWith("~") && inner.length > 1) {
          flush();
          out.push({ t: "mention", name: inner.slice(1), id: inner.slice(1) });
          i = e + 1;
          continue;
        }
        if (inner.startsWith("^") && inner.length > 1) {
          flush();
          out.push({ t: "attachment", name: inner.slice(1) });
          i = e + 1;
          continue;
        }
        const parts = inner.split("|");
        const url = parts.length > 1 ? parts[1].trim() : inner.trim();
        if (parts.length > 1 && url !== "" && !/\s/.test(url)) {
          flush();
          const label = parts[0].trim();
          out.push({ t: "link", url, c: label ? segsToInlines(parseInline(label)) : [{ t: "text", v: url }] });
          i = e + 1;
          continue;
        }
        if (parts.length === 1 && isUrl(url)) {
          flush();
          out.push({ t: "link", url, c: [{ t: "text", v: url }] });
          i = e + 1;
          continue;
        }
      }
    }
    if (c === "!" && !isAlnum(prev)) {
      const m = /^!([^!\s|][^!\n]*)!/.exec(s.slice(i, i + 600));
      const img = m ? image(m[1]) : null;
      if (m && img) {
        flush();
        out.push(img);
        i += m[0].length;
        continue;
      }
    }
    if (c === "h" && !isAlnum(prev) && (s.startsWith("http://", i) || s.startsWith("https://", i))) {
      const e = urlEnd(s, i);
      if (e > i + 8) {
        flush();
        const url = s.slice(i, e);
        out.push({ t: "link", url, c: [{ t: "text", v: url }] });
        i = e;
        continue;
      }
    }
    if ((c === ":" || c === ";" || c === "(") && (isSpace(prev) || i === 0)) {
      const m = /^(?::\)|:\(|;\)|:D|:P|\(\/\)|\(x\)|\(!\)|\(i\)|\(y\)|\(n\)|\(\?\))/.exec(s.slice(i, i + 3));
      if (m && !isAlnum(s[i + m[0].length])) {
        flush();
        out.push({ t: "emoji", v: EMOJI[m[0]] });
        i += m[0].length;
        continue;
      }
    }
    const kind = SPAN[c];
    if (kind && !isAlnum(prev) && !isSpace(s[i + 1]) && (s[i + 1] !== c || c === "?")) {
      const double = c === "?" && s[i + 1] === "?";
      if (c !== "?" || double) {
        const from = i + (double ? 2 : 1);
        const e = double ? s.indexOf("??", from) : closer(s, from, c);
        if (e > from && e - from < REACH) {
          flush();
          const kids = segsToInlines(parseInline(s.slice(from, e)));
          if (kind === "plain") out.push(...kids);
          else out.push({ t: kind, c: kids });
          i = e + (double ? 2 : 1);
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

const inl = (s: string): Inline[] => segsToInlines(parseInline(s));

// ---- blocks ----

const MACRO = /^\{(code|noformat|quote|panel|info|note|warning|tip)(?::([^}]*))?\}(.*)$/;
const HEADING = /^h([1-6])\.\s+(.*)$/;
const LISTLINE = /^[ \t]*([*#-]+)[ \t]+(.*)$/;
const RULE = /^-{4,}[ \t]*$/;

const isTableLine = (l: string): boolean => l.trimStart().startsWith("|");

/** `a|b` params of a macro: the value of `key`, or the first bare one */
function param(params: string | undefined, key: string): string | undefined {
  if (!params) return undefined;
  for (const p of params.split("|")) {
    const eq = p.indexOf("=");
    if (eq > 0 && p.slice(0, eq).trim() === key) return p.slice(eq + 1).trim();
  }
  return undefined;
}

function bare(params: string | undefined): string | undefined {
  const first = params?.split("|")[0];
  return first && !first.includes("=") ? first.trim() || undefined : undefined;
}

type Item = { depth: number; ordered: boolean; text: string };

function buildList(items: Item[], depth: number): Block[] {
  const blocks: Block[] = [];
  let cur: { ordered: boolean; items: ListItem[] } | null = null;
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.depth > depth) {
      // a deeper run belongs to the previous item
      let j = i;
      while (j < items.length && items[j].depth > depth) j++;
      const nested = buildList(items.slice(i, j), depth + 1);
      if (!cur) {
        cur = { ordered: it.ordered, items: [] };
        blocks.push({ t: "list", ordered: cur.ordered, items: cur.items });
      }
      if (cur.items.length === 0) cur.items.push({ checked: null, c: [] });
      cur.items[cur.items.length - 1].c.push(...nested);
      i = j;
      continue;
    }
    if (!cur || cur.ordered !== it.ordered) {
      cur = { ordered: it.ordered, items: [] };
      blocks.push({ t: "list", ordered: it.ordered, items: cur.items });
    }
    cur.items.push({ checked: null, c: segsToBlocks(parseInline(it.text)) });
    i++;
  }
  return blocks;
}

/** Splits a table row on pipes that are not part of a [link|x] or !img|opts! */
function splitCells(line: string, sep: string): string[] {
  const guarded = line
    .replace(/\[[^\]\n]*\]/g, (m) => m.replaceAll("|", "\u0001"))
    .replace(/![^!\s|][^!\n]*!/g, (m) => m.replaceAll("|", "\u0001"));
  return guarded.split(sep).map((c) => c.replaceAll("\u0001", "|"));
}

function tableRow(line: string): { header: boolean; cells: Inline[][] } {
  const t = line.trim();
  const header = t.startsWith("||");
  const body = header ? t.replace(/^\|\|/, "").replace(/\|\|?$/, "") : t.replace(/^\|/, "").replace(/\|$/, "");
  const cells = splitCells(body, header ? "||" : "|").map((c) => inl(c.trim()));
  return { header, cells };
}

const PANEL_KIND: Record<string, Panel> = { panel: "info", info: "info", note: "note", warning: "warning", tip: "success" };

function parseBlocks(input: string[]): Block[] {
  const lines = [...input];
  const out: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) out.push(...segsToBlocks(parseInline(para.join("\n"))));
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    const mac = MACRO.exec(line.trimStart());
    if (mac) {
      flushPara();
      const [, name, params, rest] = mac;
      const close = `{${name}}`;
      // body: the rest of the opening line, then lines up to the closing macro
      const body: string[] = [];
      let tail = "";
      const same = rest.indexOf(close);
      if (same >= 0) {
        body.push(rest.slice(0, same));
        tail = rest.slice(same + close.length);
        i++;
      } else {
        body.push(rest);
        i++;
        while (i < lines.length) {
          const k = lines[i].indexOf(close);
          if (k >= 0) {
            body.push(lines[i].slice(0, k));
            tail = lines[i].slice(k + close.length);
            i++;
            break;
          }
          body.push(lines[i]);
          i++;
        }
      }
      while (body.length > 0 && body[0].trim() === "") body.shift();
      while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
      if (name === "code" || name === "noformat") {
        const lang = name === "code" ? (param(params, "language") ?? bare(params)) : undefined;
        out.push({ t: "code", ...(lang ? { lang } : {}), v: body.join("\n") });
      } else if (name === "quote") {
        out.push({ t: "quote", c: parseBlocks(body) });
      } else {
        const title = param(params, "title");
        const head: Block[] = title ? [{ t: "p", c: [{ t: "strong", c: inl(title) }] }] : [];
        out.push({ t: "panel", kind: PANEL_KIND[name], c: [...head, ...parseBlocks(body)] });
      }
      if (tail.trim() !== "") lines.splice(i, 0, tail);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      out.push({ t: "h", level: Number(h[1]) as 1 | 2 | 3 | 4 | 5 | 6, c: inl(h[2].trim()) });
      i++;
      continue;
    }
    const bq = /^bq\.\s+(.*)$/.exec(line);
    if (bq) {
      flushPara();
      out.push({ t: "quote", c: segsToBlocks(parseInline(bq[1])) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (isTableLine(line)) {
      flushPara();
      const rows: ReturnType<typeof tableRow>[] = [];
      while (i < lines.length && isTableLine(lines[i])) rows.push(tableRow(lines[i++]));
      out.push({ t: "table", header: rows[0].header, rows: rows.map((r) => r.cells) });
      continue;
    }
    if (LISTLINE.test(line)) {
      flushPara();
      const items: Item[] = [];
      for (let m = LISTLINE.exec(lines[i] ?? ""); m; m = LISTLINE.exec(lines[i] ?? "")) {
        items.push({ depth: m[1].length, ordered: m[1].endsWith("#"), text: m[2] });
        i++;
      }
      out.push(...buildList(items, 1));
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out;
}

export function fromJiraWiki(text: string): RichDoc {
  try {
    if (typeof text !== "string" || text.trim() === "") return emptyDoc();
    return { v: 1, blocks: parseBlocks(text.replace(/\r\n?/g, "\n").split("\n")) };
  } catch {
    return emptyDoc();
  }
}
