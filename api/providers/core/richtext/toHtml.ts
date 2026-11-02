// Markdown going out to a service that takes a little HTML, or none: what the
// writers share (escaping, inline marks with each service's tags, lists, the
// block markup a service drops) and the warnings for what it won't show as
// written. Each writer keeps its own block layout.
import type { MarkdownFeature } from "@contracts/providers";
import type { ConversionWarning } from "../../types";

export const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A service's tags for the inline marks; no `code`: a code span is written as its text. */
export type InlineTags = { strong: string; em: string; strike: string; code?: string };

const link = (label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label || url}</a>`;
const LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;
const LINK_OR_IMAGE = /!?\[([^\]]*)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;
const IMAGE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * Inline Markdown as HTML with a service's tags: links (http, mailto), strong,
 * em, strike, code spans left alone inside. An image is a link to it; with
 * `note`, it is said, and so is a code span written as text.
 */
export function inlineHtml(text: string, tags: InlineTags, note?: (f: "code" | "image") => void): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, n) => {
      if (n % 2 === 1) {
        if (tags.code) return `<${tags.code}>${escapeHtml(part.slice(1, -1))}</${tags.code}>`;
        note?.("code");
        return escapeHtml(part.slice(1, -1));
      }
      const html = escapeHtml(part);
      const linked = note
        ? html
            .replace(IMAGE, (_m, alt: string, url: string) => {
              note("image");
              return link(alt, url);
            })
            .replace(LINK, (_m, label: string, url: string) => link(label, url))
        : html.replace(LINK_OR_IMAGE, (_m, label: string, url: string) => link(label, url));
      return linked
        .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<${tags.strong}>${a ?? b}</${tags.strong}>`)
        .replace(/~~([^~\n]+)~~/g, `<${tags.strike}>$1</${tags.strike}>`)
        .replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?!\w)|(^|[^_\w])_([^_\s][^_\n]*)_(?!\w)/g, (_m, p1: string | undefined, a: string | undefined, p2: string | undefined, b: string | undefined) => `${p1 ?? p2 ?? ""}<${tags.em}>${a ?? b}</${tags.em}>`);
    })
    .join("");
}

/** A list being written: its tag and its items' HTML. */
export type HtmlList = { tag: "ul" | "ol"; items: string[] };

/** A list item's line: the list it belongs in, and its text. */
export function listItemOf(line: string): { tag: HtmlList["tag"]; text: string } | null {
  const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  return m ? { tag: /\d/.test(m[1]) ? "ol" : "ul", text: m[2] } : null;
}

export const listHtml = (list: HtmlList) => `<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`;

/** A line without the block markup a service can't keep (a heading's #, a quote's >), each loss said; tables and images too. */
export function withoutBlockMarks(line: string, approximate: (f: MarkdownFeature) => void): string {
  let text = line;
  if (/^#{1,6}\s/.test(text)) {
    approximate("heading");
    text = text.replace(/^#{1,6}\s+/, "");
  }
  if (/^>\s?/.test(text)) {
    approximate("quote");
    text = text.replace(/^>\s?/, "");
  }
  if (/^\|.*\|\s*$/.test(text)) approximate("table");
  if (/!\[[^\]]*\]\([^)]+\)/.test(text)) approximate("image");
  return text;
}

/** What a writer approximated, each feature once in the order met; `sentAs` ("Asana as plain text") explains it in the server's log. */
export function approximations(sentAs?: string) {
  const seen = new Map<MarkdownFeature, ConversionWarning>();
  return {
    approximate: (feature: MarkdownFeature) => {
      seen.set(feature, { code: "approximated", feature, ...(sentAs ? { serverDetail: `markdown ${feature} sent to ${sentAs}` } : {}) });
    },
    warnings: (): ConversionWarning[] => [...seen.values()],
  };
}

/** Markdown a service won't show as written, for one that gets the text as is. */
const MARKS: [MarkdownFeature, RegExp][] = [
  ["strong", /\*\*[^*]+\*\*/],
  ["emphasis", /(^|[^*])\*[^*\s][^*]*\*/],
  ["code", /`[^`]+`/],
  ["codeBlock", /^```/m],
  ["link", /\[[^\]]+\]\([^)]+\)/],
  ["heading", /^#{1,6} /m],
  ["list", /^\s*([-*+]|\d+\.) /m],
  ["quote", /^> /m],
  ["table", /^\|.*\|$/m],
  ["image", /!\[[^\]]*\]\([^)]+\)/],
];

/** The Markdown features a text uses (of `only`, when given) that went out as `sentAs` ("Jira as plain text"). */
export const markdownWarnings = (md: string, sentAs: string, only?: readonly MarkdownFeature[]): ConversionWarning[] =>
  MARKS.filter(([feature, re]) => (!only || only.includes(feature)) && re.test(md)).map(([feature]) => ({ code: "approximated" as const, feature, serverDetail: `markdown ${feature} sent to ${sentAs}` }));

/** Plain text as HTML paragraphs on blank lines, single newlines as <br> (`keepEmpty`: an empty paragraph is still written). */
export const htmlParagraphs = (md: string, tag: "p" | "div", keepEmpty: boolean) =>
  md
    .split(/\n{2,}/)
    .filter((p) => keepEmpty || p.trim())
    .map((p) => `<${tag}>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</${tag}>`)
    .join("");
