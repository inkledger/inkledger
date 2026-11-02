// The Markdown writers built on toHtml.ts: one text through each, as each service gets it.
import { describe, expect, it } from "vitest";
import { toAsanaHtml } from "../../asana/adapter";
import { toBasecampHtml } from "../../basecamp/adapter";
import { toMondayHtml } from "../../monday/adapter";
import { toWrikeHtml } from "../../wrike/adapter";
import { htmlParagraphs, markdownWarnings } from "./toHtml";

const MIXED = "mixed **all** _the_ `things` [x](https://x.y) ![i](https://i.j/k.png)\n\n# head\n> q\n- l\n1. n\n```\nc\n```\n| t |";

describe("Markdown out as each service's HTML", () => {
  it("keeps each service's tags and block layout", () => {
    expect(toAsanaHtml(MIXED).html).toBe(
      '<body>mixed <strong>all</strong> <em>the</em> <code>things</code> <a href="https://x.y">x</a> <a href="https://i.j/k.png">i</a>\n\nhead\nq<ul><li>l</li></ul><ol><li>n</li></ol>c\n| t |</body>',
    );
    expect(toWrikeHtml(MIXED).html).toBe(
      'mixed <b>all</b> <i>the</i> <code>things</code> <a href="https://x.y">x</a> <a href="https://i.j/k.png">i</a><br /><br />head<br />q<ul><li>l</li></ul><ol><li>n</li></ol>c<br />| t |',
    );
    expect(toBasecampHtml(MIXED).html).toBe(
      '<div>mixed <strong>all</strong> <em>the</em> things <a href="https://x.y">x</a> <a href="https://i.j/k.png">i</a></div><h1>head</h1><blockquote><div>q</div></blockquote><ul><li>l</li></ul><ol><li>n</li></ol><pre>c</pre><div>| t |</div>',
    );
    expect(toMondayHtml(MIXED).html).toBe('<p>mixed <strong>all</strong> <em>the</em> things <a href="https://x.y">x</a> !<a href="https://i.j/k.png">i</a></p><p>head</p><p>q</p><ul><li>l</li></ul><ol><li>n</li></ol><p>c</p><p>| t |</p>');
    expect(toAsanaHtml(MIXED).warnings.map((w) => w.feature)).toEqual(["image", "heading", "quote", "codeBlock", "table"]);
  });

  it("says an image once and keeps it as a link where images are noted (Basecamp)", () => {
    expect(toBasecampHtml("![alt](https://img.example/a.png) ![m](mailto:x@y.z) ![](http://x.y/z.png)")).toEqual({
      html: '<div><a href="https://img.example/a.png">alt</a> !<a href="mailto:x@y.z">m</a> <a href="http://x.y/z.png">http://x.y/z.png</a></div>',
      warnings: [{ code: "approximated", feature: "image" }],
    });
  });

  it("names what plain text loses, of all features or some", () => {
    expect(markdownWarnings(MIXED, "Jira as plain text").map((w) => w.feature)).toEqual(["strong", "code", "codeBlock", "link", "heading", "list", "quote", "table", "image"]);
    expect(markdownWarnings(MIXED, "Notion as text", ["codeBlock", "heading", "list", "quote", "table", "image"]).map((w) => w.feature)).toEqual(["codeBlock", "heading", "list", "quote", "table", "image"]);
    expect(markdownWarnings("**b**", "Plane as plain paragraphs")).toEqual([{ code: "approximated", feature: "strong", serverDetail: "markdown strong sent to Plane as plain paragraphs" }]);
  });

  it("writes plain paragraphs, empty ones kept or not", () => {
    expect(htmlParagraphs("one\n\n\n\ntwo\n", "div", true)).toBe("<div>one</div><div>two</div>");
    expect(htmlParagraphs("", "div", true)).toBe("<div></div>");
    expect(htmlParagraphs("", "p", false)).toBe("");
    expect(htmlParagraphs("a & b\nc", "p", false)).toBe("<p>a &amp; b<br>c</p>");
  });
});
