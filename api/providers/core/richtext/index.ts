// A tracker's text, whatever markup it is written in, as one RichDoc.

import { emptyDoc, type Block, type RichDoc } from "@contracts/richtext";
import type { RemoteBody } from "../../types";
import { fromAdf } from "./adf";
import { fromHtml } from "./html";
import { fromMarkdown } from "./markdown";
import { fromJiraWiki } from "./wiki";

export { fromAdf, fromHtml, fromJiraWiki, fromMarkdown };

/** Paragraphs on blank lines, a break on a single newline */
export function fromPlain(text: string): RichDoc {
  const blocks: Block[] = [];
  let group: string[] = [];
  const flush = () => {
    if (group.length > 0) {
      const c = group.flatMap((l, i) => (i === 0 ? [{ t: "text" as const, v: l }] : [{ t: "br" as const }, { t: "text" as const, v: l }]));
      blocks.push({ t: "p", c });
    }
    group = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "") flush();
    else group.push(line.trim());
  }
  flush();
  return { v: 1, blocks };
}

/** Textile is close to Jira wiki: rewrite its few differences, then read it as wiki */
function textileToWiki(text: string): string {
  const out: string[] = [];
  let code: string[] | null = null;
  const endCode = () => {
    if (code) out.push("{code}", ...code, "{code}");
    code = null;
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (code) {
      if (line.trim() === "") endCode();
      else code.push(line);
      continue;
    }
    const bc = /^(?:bc|pre)\.\.?\s+(.*)$/.exec(line);
    if (bc) {
      code = [bc[1]];
      continue;
    }
    out.push(
      line
        .replace(/^p(?:\([^)]*\))?\.\s+/, "")
        .replace(/"([^"\n]+)":(\S+)/g, "[$1|$2]")
        .replace(/@([^@\n]+)@/g, "{{$1}}"),
    );
  }
  endCode();
  return out.join("\n");
}

export function toRichDoc(body: RemoteBody | null): RichDoc {
  if (!body) return emptyDoc();
  if (body.kind === "structured") return body.format === "adf" ? fromAdf(body.payload) : fromMarkdown(body.preview, "commonmark");
  switch (body.format) {
    case "jira-wiki":
      return fromJiraWiki(body.text);
    case "commonmark":
    case "gfm":
    case "glfm":
      return fromMarkdown(body.text, body.format);
    case "html":
      return fromHtml(body.text);
    case "textile":
      return fromJiraWiki(textileToWiki(body.text));
    case "plain":
      return fromPlain(body.text);
  }
}
