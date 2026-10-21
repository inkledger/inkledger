// CommonMark / GFM / GLFM -> RichDoc. A pragmatic block parser (containers
// recurse on stripped lines) and a scanning inline parser. Pure, never throws.

import { emptyDoc, plainText, type Block, type Inline, type ListItem, type RichDoc } from "@contracts/richtext";

export type MarkdownFlavor = "commonmark" | "gfm" | "glfm";

type Image = Extract<Block, { t: "image" }>;
type Seg = Inline | Image;
type Cx = { gh: boolean; glfm: boolean; refs: Map<string, string> };

// how far an inline marker looks for its partner
const REACH = 4000;
const ALERTS: Record<string, Extract<Block, { t: "panel" }>["kind"]> = {
  NOTE: "note",
  TIP: "info",
  IMPORTANT: "info",
  WARNING: "warning",
  CAUTION: "error",
};
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isPunct = (c: string | undefined): boolean => c !== undefined && /[!-/:-@[-`{-~]/.test(c);
const normLabel = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

// ---- seg helpers ----

/** Images split a paragraph; inside a link or a cell they shrink to text, a link or an attachment */
function segsToInlines(segs: Seg[], inLink = false): Inline[] {
  return segs.map((s): Inline => {
    if (s.t !== "image") return s;
    if (inLink) return { t: "text", v: s.alt ?? s.name ?? "" };
    if (s.url) return { t: "link", url: s.url, c: [{ t: "text", v: s.alt ?? s.url }] };
    return { t: "attachment", name: s.name ?? "" };
  });
}

const blank = (x: Inline): boolean => x.t === "br" || (x.t === "text" && x.v.trim() === "");

function segsToBlocks(segs: Seg[]): Block[] {
  const out: Block[] = [];
  let run: Inline[] = [];
  const flush = () => {
    if (!run.every(blank)) out.push({ t: "p", c: run });
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

function imageOf(dest: string, alt: string): Image {
  const a = alt ? { alt } : {};
  if (!/^[a-z][a-z0-9+.-]*:/i.test(dest) && !dest.includes("/")) {
    let name = dest;
    try {
      name = decodeURIComponent(dest);
    } catch {
      /* keep as written */
    }
    return { t: "image", name, ...a };
  }
  return { t: "image", url: dest, ...a };
}

// ---- inlines ----

function decodeEntity(body: string): string | null {
  if (body.startsWith("#")) {
    const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
  }
  return ENTITIES[body] ?? null;
}

/** End index (exclusive) of the bracketed text starting at `[` i, or -1 */
function matchBracket(s: string, i: number): number {
  let depth = 0;
  const end = Math.min(s.length, i + REACH);
  for (let k = i; k < end; k++) {
    const c = s[k];
    if (c === "\\") k++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return k;
  }
  return -1;
}

const unescapeMd = (s: string): string => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");

/** `[text](dest "title")`, `[text][ref]` or `[ref]` at i. `end` is after the whole construct. */
function linkAt(s: string, i: number, cx: Cx): { end: number; inner: string; url: string } | null {
  const close = matchBracket(s, i);
  if (close < 0) return null;
  const inner = s.slice(i + 1, close);
  const next = s[close + 1];
  if (next === "(") {
    let k = close + 2;
    while (k < s.length && /\s/.test(s[k])) k++;
    let dest = "";
    if (s[k] === "<") {
      const e = s.indexOf(">", k);
      if (e < 0 || s.slice(k, e).includes("\n")) return null;
      dest = s.slice(k + 1, e);
      k = e + 1;
    } else {
      let depth = 0;
      const from = k;
      while (k < s.length && k - from < 2000) {
        const c = s[k];
        if (c === "\\") k += 2;
        else if (/\s/.test(c)) break;
        else if (c === "(") {
          depth++;
          k++;
        } else if (c === ")") {
          if (depth === 0) break;
          depth--;
          k++;
        } else k++;
      }
      dest = s.slice(from, k);
    }
    while (k < s.length && /\s/.test(s[k])) k++;
    const q = s[k];
    if (q === '"' || q === "'" || q === "(") {
      const e = s.indexOf(q === "(" ? ")" : q, k + 1);
      if (e < 0) return null;
      k = e + 1;
      while (k < s.length && /\s/.test(s[k])) k++;
    }
    return s[k] === ")" ? { end: k + 1, inner, url: unescapeMd(dest) } : null;
  }
  if (next === "[") {
    const e = s.indexOf("]", close + 2);
    if (e < 0 || e - close > 1000) return null;
    const label = e === close + 2 ? inner : s.slice(close + 2, e);
    const url = cx.refs.get(normLabel(label));
    return url === undefined ? null : { end: e + 1, inner, url };
  }
  const url = cx.refs.get(normLabel(inner));
  return url === undefined ? null : { end: close + 1, inner, url };
}

/** Start of the closing run for an emphasis opened before `from`, or -1 */
function findClose(s: string, from: number, c: string, use: number): number {
  let pending = 0; // openers of the same kind met on the way
  const end = Math.min(s.length, from + REACH);
  let k = from;
  while (k < end) {
    const ch = s[k];
    if (ch === "\\") {
      k += 2;
      continue;
    }
    if (ch !== c) {
      k++;
      continue;
    }
    let l = 1;
    while (s[k + l] === c) l++;
    const before = s[k - 1];
    const after = s[k + l];
    const canClose = k > from && !isSpace(before) && (c === "*" || !isAlnum(after));
    if (canClose) {
      if (pending > 0) pending--;
      else if (l >= use) return k;
    } else if (!isSpace(after) && (c === "*" || !isAlnum(before))) pending++;
    k += l;
  }
  return -1;
}

function urlEnd(s: string, from: number): number {
  let j = from;
  while (j < s.length && !/[\s<]/.test(s[j])) j++;
  for (;;) {
    const last = s[j - 1];
    if (j > from && /[?!.,:*_~'"]/.test(last)) j--;
    else if (j > from && last === ")" && s.slice(from, j).split("(").length < s.slice(from, j).split(")").length) j--;
    else return j;
  }
}

function inlineMd(s: string, cx: Cx, inLink = false): Seg[] {
  const out: Seg[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  const push = (x: Seg) => {
    flush();
    out.push(x);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const prev = s[i - 1];
    if (c === "\n") {
      const hard = buf.endsWith("  ");
      buf = buf.trimEnd();
      if (hard || cx.gh) push({ t: "br" });
      else buf += " ";
      i++;
      continue;
    }
    if (c === "\\") {
      if (s[i + 1] === "\n") {
        push({ t: "br" });
        i += 2;
        continue;
      }
      if (isPunct(s[i + 1])) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
    }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const limit = Math.min(s.length, i + REACH);
      let k = i + n;
      let found = -1;
      while (k < limit) {
        const e = s.indexOf("`", k);
        if (e < 0 || e >= limit) break;
        let l = 1;
        while (s[e + l] === "`") l++;
        if (l === n) {
          found = e;
          break;
        }
        k = e + l;
      }
      if (found >= 0) {
        let v = s.slice(i + n, found).replaceAll("\n", " ");
        if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ") && v.trim() !== "") v = v.slice(1, -1);
        push({ t: "code", v });
        i = found + n;
      } else {
        buf += "`".repeat(n);
        i += n;
      }
      continue;
    }
    if (c === "<") {
      const head = s.slice(i, i + 2100);
      if (head.startsWith("<!--")) {
        const e = s.indexOf("-->", i + 4);
        i = e < 0 ? s.length : e + 3;
        continue;
      }
      const auto = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/.exec(head);
      if (auto && !inLink) {
        push({ t: "link", url: auto[1], c: [{ t: "text", v: auto[1] }] });
        i += auto[0].length;
        continue;
      }
      const mail = /^<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)>/.exec(head);
      if (mail && !inLink) {
        push({ t: "link", url: `mailto:${mail[1]}`, c: [{ t: "text", v: mail[1] }] });
        i += mail[0].length;
        continue;
      }
      const tag = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?>/.exec(head);
      if (tag) {
        const name = tag[2].toLowerCase();
        i += tag[0].length;
        if (name === "br") push({ t: "br" });
        else if (name === "img" && tag[1] === "") {
          const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0]);
          const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0]);
          const dest = src?.[1] ?? src?.[2];
          if (dest) push(imageOf(dest, alt?.[1] ?? alt?.[2] ?? ""));
        } else if ((name === "script" || name === "style") && tag[1] === "") {
          // raw text element: its content is not text
          const e = s.toLowerCase().indexOf(`</${name}`, i);
          const gt = e < 0 ? -1 : s.indexOf(">", e);
          i = gt < 0 ? s.length : gt + 1;
        }
        continue;
      }
    }
    if (c === "&") {
      const m = /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/.exec(s.slice(i, i + 12));
      const d = m ? decodeEntity(m[1]) : null;
      if (m && d !== null) {
        buf += d;
        i += m[0].length;
        continue;
      }
    }
    if (c === "!" && s[i + 1] === "[") {
      const l = linkAt(s, i + 1, cx);
      if (l && l.url !== "") {
        const alt = plainText({ v: 1, blocks: [{ t: "p", c: segsToInlines(inlineMd(l.inner, cx, true), true) }] });
        push(imageOf(l.url, alt));
        i = l.end;
        continue;
      }
    }
    if (c === "[" && !inLink) {
      const l = linkAt(s, i, cx);
      if (l) {
        const kids = segsToInlines(inlineMd(l.inner, cx, true), true);
        if (l.url === "") {
          flush();
          out.push(...kids);
        }
        else push({ t: "link", url: l.url, c: kids });
        i = l.end;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      let r = 1;
      while (s[i + r] === c) r++;
      const after = s[i + r];
      if (!isSpace(after) && (c === "*" || !isAlnum(prev))) {
        let done = false;
        for (let use = Math.min(r, 3); use >= 1 && !done; use--) {
          const k = findClose(s, i + r, c, use);
          if (k < 0) continue;
          const kids = segsToInlines(inlineMd(s.slice(i + r, k), cx, inLink), inLink);
          buf += c.repeat(r - use);
          const em: Inline = use === 1 ? { t: "em", c: kids } : use === 2 ? { t: "strong", c: kids } : { t: "strong", c: [{ t: "em", c: kids }] };
          push(em);
          i = k + use;
          done = true;
        }
        if (done) continue;
      }
      buf += c.repeat(r);
      i += r;
      continue;
    }
    if (c === "~" && cx.gh && s[i + 1] === "~" && s[i + 2] !== "~" && !isSpace(s[i + 2])) {
      const e = s.indexOf("~~", i + 2);
      if (e > i + 2 && e - i < REACH && !isSpace(s[e - 1])) {
        push({ t: "strike", c: segsToInlines(inlineMd(s.slice(i + 2, e), cx, inLink), inLink) });
        i = e + 2;
        continue;
      }
    }
    if (cx.gh && !inLink) {
      if ((c === "h" || c === "w") && !isAlnum(prev) && prev !== "/" && (s.startsWith("http://", i) || s.startsWith("https://", i) || s.startsWith("www.", i))) {
        const e = urlEnd(s, i);
        const text = s.slice(i, e);
        if (e - i > 8 && (c === "h" || text.indexOf(".", 4) > 4)) {
          push({ t: "link", url: c === "w" ? `http://${text}` : text, c: [{ t: "text", v: text }] });
          i = e;
          continue;
        }
      }
      if (c === "@" && (prev === undefined || !/[A-Za-z0-9_.+/@-]/.test(prev))) {
        const m = /^[A-Za-z0-9][A-Za-z0-9-]*/.exec(s.slice(i + 1, i + 40));
        const name = m?.[0].replace(/-+$/, "");
        if (name) {
          push({ t: "mention", name, id: name });
          i += 1 + name.length;
          continue;
        }
      }
      if (c === ":" && !isAlnum(prev)) {
        const m = /^:([a-z0-9_+-]{1,40}):/.exec(s.slice(i, i + 42));
        if (m && (/[a-z]/.test(m[1]) || m[1] === "+1" || m[1] === "-1")) {
          push({ t: "emoji", v: m[0] });
          i += m[0].length;
          continue;
        }
      }
    }
    if (c === "$" && cx.glfm && !isAlnum(prev) && prev !== "\\" && !isSpace(s[i + 1]) && !/\d/.test(s[i + 1])) {
      const nl = s.indexOf("\n", i);
      const lim = Math.min(nl < 0 ? s.length : nl, i + 500);
      let e = s.indexOf("$", i + 1);
      while (e >= 0 && e < lim && (isSpace(s[e - 1]) || /\d/.test(s[e + 1] ?? ""))) e = s.indexOf("$", e + 1);
      if (e > i + 1 && e < lim) {
        push({ t: "code", v: s.slice(i + 1, e) });
        i = e + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// ---- blocks ----

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const REFDEF = /^ {0,3}\[([^\]\s][^\]]*)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const BULLET = /^( {0,3})([-+*])(?:[ \t]+|$)/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])(?:[ \t]+|$)/;

const isBlank = (l: string): boolean => l.trim() === "";
const indentOf = (l: string): number => l.length - l.trimStart().length;
const isFence = (l: string): boolean => {
  const m = FENCE.exec(l);
  return !!m && !(m[2][0] === "`" && m[3].includes("`"));
};

type Marker = { indent: number; ordered: boolean; ch: string; content: number; empty: boolean; first: boolean };

function markerOf(l: string): Marker | null {
  const b = BULLET.exec(l);
  const o = b ? null : ORDERED.exec(l);
  const m = b ?? o;
  if (!m) return null;
  const width = m[1].length + (b ? 1 : m[2].length + 1);
  const rest = l.slice(width);
  const spaces = rest.length - rest.trimStart().length;
  const empty = rest.trim() === "";
  const content = empty || spaces >= 5 ? width + 1 : width + spaces;
  return { indent: m[1].length, ordered: !b, ch: b ? m[2] : m[3], content, empty, first: !!o && Number(o[2]) === 1 };
}

/** May this line cut a paragraph short? */
function interrupts(l: string): boolean {
  if (isFence(l) || ATX.test(l) || HR.test(l) || QUOTE.test(l)) return true;
  const m = markerOf(l);
  return !!m && !m.empty && (!m.ordered || m.first);
}

function splitRow(l: string): string[] {
  let t = l.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < t.length; k++) {
    if (t[k] === "\\" && t[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (t[k] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += t[k];
  }
  cells.push(cur.trim());
  return cells;
}

const isDelimRow = (l: string): boolean => l.includes("|") && l.includes("-") && splitRow(l).every((c) => /^:?-+:?$/.test(c));

function blocks(lines: string[], cx: Cx): Block[] {
  const out: Block[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    // fenced code
    const fm = FENCE.exec(line);
    if (fm && !(fm[2][0] === "`" && fm[3].includes("`"))) {
      const indent = fm[1].length;
      const body: string[] = [];
      i++;
      while (i < n) {
        const t = lines[i].trim();
        if (indentOf(lines[i]) < 4 && t.length >= fm[2].length && [...t].every((ch) => ch === fm[2][0])) {
          i++;
          break;
        }
        body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
        i++;
      }
      const lang = fm[3].trim().split(/\s+/)[0].replace(/^\{?\.?/, "").replace(/\}$/, "");
      out.push({ t: "code", ...(lang ? { lang } : {}), v: body.join("\n") });
      continue;
    }

    const hm = ATX.exec(line);
    if (hm) {
      const text = (hm[2] ?? "").trim().replace(/(^|[ \t])#+$/, "").trim();
      out.push({ t: "h", level: hm[1].length as 1 | 2 | 3 | 4 | 5 | 6, c: segsToInlines(inlineMd(text, cx)) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    // blockquote, with lazy continuation lines
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < n) {
        const l = lines[i];
        const last = inner[inner.length - 1];
        if (QUOTE.test(l)) inner.push(l.replace(/^ {0,3}> ?/, ""));
        else if (!isBlank(l) && last !== undefined && !isBlank(last) && !interrupts(l) && !isFence(last) && !ATX.test(last) && !HR.test(last)) inner.push(l);
        else break;
        i++;
      }
      const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i.exec(inner[0] ?? "");
      if (alert) out.push({ t: "panel", kind: ALERTS[alert[1].toUpperCase()], c: blocks(inner.slice(1), cx) });
      else out.push({ t: "quote", c: blocks(inner, cx) });
      continue;
    }

    // lists
    const first = markerOf(line);
    if (first) {
      const items: ListItem[] = [];
      while (i < n) {
        const cur = markerOf(lines[i]);
        if (!cur || cur.ordered !== first.ordered || cur.ch !== first.ch || HR.test(lines[i])) break;
        const body: string[] = [lines[i].slice(cur.content)];
        i++;
        while (i < n) {
          const l = lines[i];
          if (isBlank(l)) {
            let j = i;
            while (j < n && isBlank(lines[j])) j++;
            if (j >= n || indentOf(lines[j]) < cur.content) break;
            while (i < j) body.push(lines[i++]);
            continue;
          }
          const ind = indentOf(l);
          const prevLine = body[body.length - 1];
          if (ind >= cur.content) body.push(l.slice(cur.content));
          else if (ind > cur.indent && markerOf(l)) body.push(l.trimStart());
          else if (!isBlank(prevLine) && !interrupts(l) && !isFence(prevLine) && !markerOf(l)) body.push(l);
          else break;
          i++;
        }
        let checked: boolean | null = null;
        const task = cx.gh ? /^\[([ xX])\](?:[ \t]+|$)/.exec(body[0]) : null;
        if (task) {
          checked = task[1] !== " ";
          body[0] = body[0].slice(task[0].length);
        }
        items.push({ checked, c: blocks(body, cx) });
        let j = i;
        while (j < n && isBlank(lines[j])) j++;
        const sib = j < n ? markerOf(lines[j]) : null;
        if (sib && sib.ordered === first.ordered && sib.ch === first.ch && !HR.test(lines[j])) i = j;
        else break;
      }
      out.push({ t: "list", ordered: first.ordered, items });
      continue;
    }

    // GFM table
    if (cx.gh && line.includes("|") && i + 1 < n && isDelimRow(lines[i + 1])) {
      const head = splitRow(line);
      if (head.length === splitRow(lines[i + 1]).length) {
        const rows: Inline[][][] = [head.map((c) => segsToInlines(inlineMd(c, cx)))];
        i += 2;
        while (i < n && !isBlank(lines[i]) && !isFence(lines[i]) && !ATX.test(lines[i]) && !QUOTE.test(lines[i])) {
          const cells = splitRow(lines[i]);
          rows.push(head.map((_, k) => segsToInlines(inlineMd(cells[k] ?? "", cx))));
          i++;
        }
        out.push({ t: "table", header: true, rows });
        continue;
      }
    }

    // indented code
    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < n && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) body.push(lines[i++].slice(4));
      while (body.length > 0 && isBlank(body[body.length - 1])) body.pop();
      out.push({ t: "code", v: body.join("\n") });
      continue;
    }

    // paragraph (or setext heading)
    const buf = [line.trimStart()];
    i++;
    let heading: 1 | 2 | null = null;
    while (i < n) {
      const l = lines[i];
      if (isBlank(l)) break;
      const sm = SETEXT.exec(l);
      if (sm) {
        heading = sm[1][0] === "=" ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(l)) break;
      buf.push(l.trimStart());
      i++;
    }
    const text = buf.join("\n").trimEnd();
    if (heading) out.push({ t: "h", level: heading, c: segsToInlines(inlineMd(buf.map((b) => b.trim()).join(" "), cx)) });
    else out.push(...segsToBlocks(inlineMd(text, cx)));
  }
  return out;
}

/** Link reference definitions, collected from outside code fences and blanked out */
function collectRefs(lines: string[]): { lines: string[]; refs: Map<string, string> } {
  const refs = new Map<string, string>();
  let fence: string | null = null;
  const kept = lines.map((l) => {
    const fm = FENCE.exec(l);
    if (fence === null && fm && !(fm[2][0] === "`" && fm[3].includes("`"))) {
      fence = fm[2][0];
      return l;
    }
    if (fence !== null) {
      if (fm && fm[2][0] === fence && fm[3].trim() === "") fence = null;
      return l;
    }
    const d = REFDEF.exec(l);
    if (!d) return l;
    const key = normLabel(d[1]);
    if (!refs.has(key)) refs.set(key, d[2]);
    return "";
  });
  return { lines: kept, refs };
}

export function fromMarkdown(text: string, flavor: MarkdownFlavor): RichDoc {
  try {
    if (typeof text !== "string" || text.trim() === "") return emptyDoc();
    const raw = text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.replace(/^[ \t]+/, (m) => m.replaceAll("\t", "    ")));
    const { lines, refs } = collectRefs(raw);
    return { v: 1, blocks: blocks(lines, { gh: flavor !== "commonmark", glfm: flavor === "glfm", refs }) };
  } catch {
    return emptyDoc();
  }
}
