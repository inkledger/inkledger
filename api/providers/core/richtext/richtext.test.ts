import { describe, expect, it } from "vitest";
import { plainText, type Block, type Inline } from "@contracts/richtext";
import { fromAdf, fromHtml, fromJiraWiki, fromMarkdown, toRichDoc } from "./index";

const t = (v: string): Inline => ({ t: "text", v });
const p = (...c: Inline[]): Block => ({ t: "p", c });
const item = (...c: Block[]) => ({ checked: null, c });

describe("fromAdf", () => {
  const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
  const para = (...content: unknown[]) => ({ type: "paragraph", content });
  const txt = (text: string, marks?: unknown[]) => ({ type: "text", text, ...(marks ? { marks } : {}) });

  it("reads paragraphs, headings and marks", () => {
    const d = fromAdf(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [txt("Title")] },
        para(txt("a "), txt("b", [{ type: "strong" }]), txt("c", [{ type: "em" }, { type: "strike" }]), txt("d", [{ type: "code" }])),
      ),
    );
    expect(d.blocks[0]).toEqual({ t: "h", level: 2, c: [t("Title")] });
    expect(d.blocks[1]).toEqual(
      p(t("a "), { t: "strong", c: [t("b")] }, { t: "strike", c: [{ t: "em", c: [t("c")] }] }, { t: "code", v: "d" }),
    );
  });

  it("keeps links and ignores underline, color and subsup", () => {
    const d = fromAdf(
      doc(
        para(
          txt("go", [{ type: "link", attrs: { href: "https://x.test/a" } }]),
          txt("u", [{ type: "underline" }]),
          txt("c", [{ type: "textColor", attrs: { color: "#f00" } }]),
          txt("s", [{ type: "subsup", attrs: { type: "sub" } }]),
        ),
      ),
    );
    expect(d.blocks[0]).toEqual(p({ t: "link", url: "https://x.test/a", c: [t("go")] }, t("u"), t("c"), t("s")));
  });

  it("reads lists, nested lists and tasks", () => {
    const li = (...c: unknown[]) => ({ type: "listItem", content: c });
    const d = fromAdf(
      doc(
        { type: "bulletList", content: [li(para(txt("one")), { type: "orderedList", content: [li(para(txt("deep")))] }), li(para(txt("two")))] },
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "DONE" }, content: [txt("done")] },
            { type: "taskItem", attrs: { state: "TODO" }, content: [txt("todo")] },
          ],
        },
      ),
    );
    expect(d.blocks[0]).toEqual({
      t: "list",
      ordered: false,
      items: [item(p(t("one")), { t: "list", ordered: true, items: [item(p(t("deep")))] }), item(p(t("two")))],
    });
    expect(d.blocks[1]).toEqual({
      t: "list",
      ordered: false,
      items: [
        { checked: true, c: [p(t("done"))] },
        { checked: false, c: [p(t("todo"))] },
      ],
    });
  });

  it("reads code, quote, rule and panels", () => {
    const d = fromAdf(
      doc(
        { type: "codeBlock", attrs: { language: "ts" }, content: [txt("let a = 1;")] },
        { type: "blockquote", content: [para(txt("q"))] },
        { type: "rule" },
        { type: "panel", attrs: { panelType: "warning" }, content: [para(txt("careful"))] },
        { type: "panel", attrs: { panelType: "weird" }, content: [para(txt("x"))] },
      ),
    );
    expect(d.blocks).toEqual([
      { t: "code", lang: "ts", v: "let a = 1;" },
      { t: "quote", c: [p(t("q"))] },
      { t: "hr" },
      { t: "panel", kind: "warning", c: [p(t("careful"))] },
      { t: "panel", kind: "info", c: [p(t("x"))] },
    ]);
  });

  it("reads tables with a header row", () => {
    const cell = (type: string, s: string) => ({ type, content: [para(txt(s))] });
    const d = fromAdf(
      doc({
        type: "table",
        content: [
          { type: "tableRow", content: [cell("tableHeader", "A"), cell("tableHeader", "B")] },
          { type: "tableRow", content: [cell("tableCell", "1"), cell("tableCell", "2")] },
        ],
      }),
    );
    expect(d.blocks[0]).toEqual({ t: "table", header: true, rows: [[[t("A")], [t("B")]], [[t("1")], [t("2")]]] });
  });

  it("reads media as images by alt or id", () => {
    const d = fromAdf(
      doc(
        { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "abc", alt: "shot.png" } }] },
        { type: "mediaGroup", content: [{ type: "media", attrs: { type: "file", id: "uuid-1" } }] },
      ),
    );
    expect(d.blocks).toEqual([
      { t: "image", name: "shot.png" },
      { t: "image", name: "uuid-1" },
    ]);
  });

  it("reads expand as a strong title then content", () => {
    const d = fromAdf(doc({ type: "expand", attrs: { title: "More" }, content: [para(txt("inside"))] }));
    expect(d.blocks).toEqual([p({ t: "strong", c: [t("More")] }), p(t("inside"))]);
  });

  it("reads inline nodes", () => {
    const d = fromAdf(
      doc(
        para(
          { type: "mention", attrs: { id: "u1", text: "@Ann" } },
          txt(" "),
          { type: "emoji", attrs: { shortName: ":smile:", text: "\u{1F604}" } },
          { type: "hardBreak" },
          { type: "inlineCard", attrs: { url: "https://x.test/i" } },
          { type: "status", attrs: { text: "IN PROGRESS", color: "blue" } },
          { type: "date", attrs: { timestamp: "1700000000000" } },
        ),
      ),
    );
    expect(d.blocks[0]).toEqual(
      p(
        { t: "mention", name: "Ann", id: "u1" },
        t(" "),
        { t: "emoji", v: "\u{1F604}" },
        { t: "br" },
        { t: "link", url: "https://x.test/i", c: [t("https://x.test/i")] },
        { t: "code", v: "IN PROGRESS" },
        t("2023-11-14"),
      ),
    );
  });

  it("keeps the text of unknown nodes and never throws", () => {
    const d = fromAdf(doc({ type: "futureNode", content: [para(txt("kept"))] }, { type: "mystery", text: "bare" }));
    expect(plainText(d)).toContain("kept");
    expect(plainText(d)).toContain("bare");
    for (const bad of [null, undefined, 5, "x", [], {}, { type: "doc" }, { type: "doc", content: "no" }, { type: "doc", content: [null, 3, "x"] }]) {
      expect(() => fromAdf(bad)).not.toThrow();
    }
    expect(fromAdf(null)).toEqual({ v: 1, blocks: [] });
    expect(fromAdf({ type: "doc", content: "no" }).blocks).toEqual([]);
  });

  it("survives very deep nesting", () => {
    let node: unknown = para(txt("x"));
    for (let k = 0; k < 20000; k++) node = { type: "blockquote", content: [node] };
    expect(() => fromAdf(doc(node))).not.toThrow();
  });
});

describe("fromJiraWiki", () => {
  it("reads headings and inline marks", () => {
    expect(fromJiraWiki("h2. Title").blocks).toEqual([{ t: "h", level: 2, c: [t("Title")] }]);
    expect(fromJiraWiki("a *bold* and _em_ and -gone- and +under+ ok").blocks).toEqual([
      p(t("a "), { t: "strong", c: [t("bold")] }, t(" and "), { t: "em", c: [t("em")] }, t(" and "), { t: "strike", c: [t("gone")] }, t(" and "), t("under"), t(" ok")),
    ]);
  });

  it("does not treat word-internal markers as marks", () => {
    expect(plainText(fromJiraWiki("snake_case_name and well-known and 2*3*4"))).toBe("snake_case_name and well-known and 2*3*4");
  });

  it("reads monospace, links, mentions and bare urls", () => {
    expect(fromJiraWiki("{{code()}}").blocks).toEqual([p({ t: "code", v: "code()" })]);
    expect(fromJiraWiki("[docs|https://x.test/d] [https://y.test] [~jdoe]").blocks).toEqual([
      p({ t: "link", url: "https://x.test/d", c: [t("docs")] }, t(" "), { t: "link", url: "https://y.test", c: [t("https://y.test")] }, t(" "), { t: "mention", name: "jdoe", id: "jdoe" }),
    ]);
    expect(fromJiraWiki("see https://z.test/a, now").blocks).toEqual([p(t("see "), { t: "link", url: "https://z.test/a", c: [t("https://z.test/a")] }, t(", now"))]);
  });

  it("reads image and file attachments", () => {
    expect(fromJiraWiki("!shot.png|thumbnail!").blocks).toEqual([{ t: "image", name: "shot.png" }]);
    expect(fromJiraWiki("!https://img.test/a.png!").blocks).toEqual([{ t: "image", url: "https://img.test/a.png" }]);
    expect(fromJiraWiki("see [^report.pdf] please").blocks).toEqual([p(t("see "), { t: "attachment", name: "report.pdf" }, t(" please"))]);
    expect(fromJiraWiki("text !a.png! more").blocks).toEqual([p(t("text ")), { t: "image", name: "a.png" }, p(t(" more"))]);
  });

  it("leaves a lone exclamation mark alone", () => {
    expect(plainText(fromJiraWiki("Wow! That is great!"))).toBe("Wow! That is great!");
  });

  it("reads code and noformat blocks verbatim", () => {
    const d = fromJiraWiki("{code:java}\nint *a* = 1;\n{code}\n{noformat}\n_raw_\n{noformat}");
    expect(d.blocks).toEqual([
      { t: "code", lang: "java", v: "int *a* = 1;" },
      { t: "code", v: "_raw_" },
    ]);
    expect(fromJiraWiki("{code:title=x.ts|language=ts}a{code}").blocks).toEqual([{ t: "code", lang: "ts", v: "a" }]);
  });

  it("reads quotes, bq and panels", () => {
    expect(fromJiraWiki("{quote}\nsaid *it*\n{quote}").blocks).toEqual([{ t: "quote", c: [p(t("said "), { t: "strong", c: [t("it")] })] }]);
    expect(fromJiraWiki("bq. one liner").blocks).toEqual([{ t: "quote", c: [p(t("one liner"))] }]);
    expect(fromJiraWiki("{panel:title=Heads up}\nbody\n{panel}").blocks).toEqual([
      { t: "panel", kind: "info", c: [p({ t: "strong", c: [t("Heads up")] }), p(t("body"))] },
    ]);
    expect(fromJiraWiki("{warning}careful{warning}").blocks).toEqual([{ t: "panel", kind: "warning", c: [p(t("careful"))] }]);
    expect(fromJiraWiki("{tip}\nnice\n{tip}").blocks[0]).toMatchObject({ t: "panel", kind: "success" });
    expect(fromJiraWiki("{note}n{note}").blocks[0]).toMatchObject({ kind: "note" });
  });

  it("reads nested and mixed lists", () => {
    const d = fromJiraWiki("* a\n** b\n*** c\n* d\n# one\n## two\n# three");
    expect(d.blocks).toEqual([
      {
        t: "list",
        ordered: false,
        items: [item(p(t("a")), { t: "list", ordered: false, items: [item(p(t("b")), { t: "list", ordered: false, items: [item(p(t("c")))] })] }), item(p(t("d")))],
      },
      {
        t: "list",
        ordered: true,
        items: [item(p(t("one")), { t: "list", ordered: true, items: [item(p(t("two")))] }), item(p(t("three")))],
      },
    ]);
    const mixed = fromJiraWiki("# first\n#* sub bullet\n# second");
    expect(mixed.blocks[0]).toMatchObject({ ordered: true });
    expect(plainText(mixed)).toContain("sub bullet");
  });

  it("does not read bold text as a list", () => {
    expect(fromJiraWiki("*bold* start").blocks).toEqual([p({ t: "strong", c: [t("bold")] }, t(" start"))]);
  });

  it("reads tables with header cells and piped links", () => {
    const d = fromJiraWiki("||Name||Link||\n|a|[x|https://x.test]|\n|b|!i.png|width=3!|");
    expect(d.blocks[0]).toEqual({
      t: "table",
      header: true,
      rows: [
        [[t("Name")], [t("Link")]],
        [[t("a")], [{ t: "link", url: "https://x.test", c: [t("x")] }]],
        [[t("b")], [{ t: "attachment", name: "i.png" }]],
      ],
    });
  });

  it("reads rules, breaks, colors and emoji", () => {
    expect(fromJiraWiki("a\n----\nb").blocks).toEqual([p(t("a")), { t: "hr" }, p(t("b"))]);
    expect(fromJiraWiki("one\\\\two").blocks).toEqual([p(t("one"), { t: "br" }, t("two"))]);
    expect(plainText(fromJiraWiki("{color:red}warning{color} text"))).toBe("warning text");
    expect(fromJiraWiki("ok (/) done").blocks[0]).toEqual(p(t("ok "), { t: "emoji", v: "✅" }, t(" done")));
  });

  it("splits paragraphs on blank lines and breaks on single newlines", () => {
    expect(fromJiraWiki("one\ntwo\n\nthree").blocks).toEqual([p(t("one"), { t: "br" }, t("two")), p(t("three"))]);
  });

  it("handles escapes and an empty body", () => {
    expect(plainText(fromJiraWiki("\\*not bold\\*"))).toBe("*not bold*");
    expect(fromJiraWiki("  \n ").blocks).toEqual([]);
  });

  it("never throws on unclosed or nasty input", () => {
    for (const s of ["{code}\nnever closed", "{quote}{quote}{quote}", "[unclosed|", "!x", "*a _b -c +d", "||", "{{", "{panel:", "h1.", "* ", "\\", "[~", "{color:"]) {
      expect(() => fromJiraWiki(s)).not.toThrow();
    }
    expect(fromJiraWiki("{code}\nnever closed").blocks).toEqual([{ t: "code", v: "never closed" }]);
  });
});

describe("fromMarkdown", () => {
  const md = (s: string, f: "commonmark" | "gfm" | "glfm" = "commonmark") => fromMarkdown(s, f).blocks;

  it("reads ATX and setext headings", () => {
    expect(md("# One ##\n\n### Three")).toEqual([
      { t: "h", level: 1, c: [t("One")] },
      { t: "h", level: 3, c: [t("Three")] },
    ]);
    expect(md("Title\n=====\n\nSub\n---")).toEqual([
      { t: "h", level: 1, c: [t("Title")] },
      { t: "h", level: 2, c: [t("Sub")] },
    ]);
    expect(md("#nospace")).toEqual([p(t("#nospace"))]);
  });

  it("joins soft breaks by flavor", () => {
    expect(md("a\nb")).toEqual([p(t("a b"))]);
    expect(md("a\nb", "gfm")).toEqual([p(t("a"), { t: "br" }, t("b"))]);
    expect(md("a  \nb")).toEqual([p(t("a"), { t: "br" }, t("b"))]);
    expect(md("a\\\nb")).toEqual([p(t("a"), { t: "br" }, t("b"))]);
  });

  it("reads fenced and indented code", () => {
    expect(md("```ts\nlet a = *1*;\n```")).toEqual([{ t: "code", lang: "ts", v: "let a = *1*;" }]);
    expect(md("~~~\nraw\n~~~")).toEqual([{ t: "code", v: "raw" }]);
    expect(md("    indented\n    more")).toEqual([{ t: "code", v: "indented\nmore" }]);
    expect(md("```\nunclosed")).toEqual([{ t: "code", v: "unclosed" }]);
    expect(md("````\n```\ninner\n```\n````")).toEqual([{ t: "code", v: "```\ninner\n```" }]);
  });

  it("reads nested blockquotes", () => {
    expect(md("> a\n> > b")).toEqual([{ t: "quote", c: [p(t("a")), { t: "quote", c: [p(t("b"))] }] }]);
    const q = md("> outer\n>\n> > inner")[0];
    expect(q).toEqual({ t: "quote", c: [p(t("outer")), { t: "quote", c: [p(t("inner"))] }] });
  });

  it("turns GitHub alerts into panels", () => {
    expect(md("> [!NOTE]\n> remember", "gfm")).toEqual([{ t: "panel", kind: "note", c: [p(t("remember"))] }]);
    expect(md("> [!TIP]\n> t", "gfm")[0]).toMatchObject({ kind: "info" });
    expect(md("> [!IMPORTANT]\n> t", "gfm")[0]).toMatchObject({ kind: "info" });
    expect(md("> [!WARNING]\n> t", "gfm")[0]).toMatchObject({ kind: "warning" });
    expect(md("> [!CAUTION]\n> t", "glfm")[0]).toMatchObject({ kind: "error" });
  });

  it("reads bullet and ordered lists with nesting", () => {
    expect(md("- a\n  - b\n    - c\n- d")).toEqual([
      {
        t: "list",
        ordered: false,
        items: [item(p(t("a")), { t: "list", ordered: false, items: [item(p(t("b")), { t: "list", ordered: false, items: [item(p(t("c")))] })] }), item(p(t("d")))],
      },
    ]);
    expect(md("1. one\n2. two\n   - sub")).toEqual([
      { t: "list", ordered: true, items: [item(p(t("one"))), item(p(t("two")), { t: "list", ordered: false, items: [item(p(t("sub")))] })] },
    ]);
    // a deeper bullet under an ordered item, indented less than its content
    expect(md("1. one\n  - sub")[0]).toMatchObject({ ordered: true, items: [{ c: [expect.anything(), { t: "list" }] }] });
  });

  it("reads code and several paragraphs inside list items", () => {
    const l = md("- intro\n\n  ```js\n  x()\n  ```\n\n  after\n- next")[0];
    expect(l).toEqual({
      t: "list",
      ordered: false,
      items: [item(p(t("intro")), { t: "code", lang: "js", v: "x()" }, p(t("after"))), item(p(t("next")))],
    });
  });

  it("separates lists on a changed marker and keeps paragraphs apart", () => {
    expect(md("- a\n\n* b")).toHaveLength(2);
    expect(md("text\n- item")).toEqual([p(t("text")), { t: "list", ordered: false, items: [item(p(t("item")))] }]);
  });

  it("reads GFM task items only for gfm and glfm", () => {
    expect(md("- [ ] todo\n- [x] done\n- plain", "gfm")).toEqual([
      { t: "list", ordered: false, items: [{ checked: false, c: [p(t("todo"))] }, { checked: true, c: [p(t("done"))] }, item(p(t("plain")))] },
    ]);
    expect(plainText(fromMarkdown("- [x] done", "commonmark"))).toBe("[x] done");
  });

  it("reads thematic breaks", () => {
    expect(md("a\n\n***\n\n___\n\n- - -\n\nb")).toEqual([p(t("a")), { t: "hr" }, { t: "hr" }, { t: "hr" }, p(t("b"))]);
  });

  it("reads GFM tables", () => {
    const d = md("| A | B |\n|---|:-:|\n| 1 | `x` |\n| 2 \\| z |", "gfm");
    expect(d[0]).toEqual({
      t: "table",
      header: true,
      rows: [
        [[t("A")], [t("B")]],
        [[t("1")], [{ t: "code", v: "x" }]],
        [[t("2 | z")], []],
      ],
    });
    // not a table in plain CommonMark
    expect(md("| A |\n|---|", "commonmark")[0]).toMatchObject({ t: "p" });
  });

  it("reads images: attachment names, urls and relative paths", () => {
    expect(md("![shot](shot.png)")).toEqual([{ t: "image", name: "shot.png", alt: "shot" }]);
    expect(md("![x](https://i.test/a.png)")).toEqual([{ t: "image", url: "https://i.test/a.png", alt: "x" }]);
    expect(md("![](docs/a.png)")).toEqual([{ t: "image", url: "docs/a.png" }]);
    expect(md("before ![a](b.png) after")).toEqual([p(t("before ")), { t: "image", name: "b.png", alt: "a" }, p(t(" after"))]);
  });

  it("reads links, titles, autolinks, references and bare urls", () => {
    expect(md('[text](https://x.test "title")')).toEqual([p({ t: "link", url: "https://x.test", c: [t("text")] })]);
    expect(md("<https://a.test>")).toEqual([p({ t: "link", url: "https://a.test", c: [t("https://a.test")] })]);
    expect(md("[a *b*](/p(1))")).toEqual([p({ t: "link", url: "/p(1)", c: [t("a "), { t: "em", c: [t("b")] }] })]);
    expect(md("[ref][1] and [two]\n\n[1]: https://r.test\n[two]: <https://t.test>")).toEqual([
      p({ t: "link", url: "https://r.test", c: [t("ref")] }, t(" and "), { t: "link", url: "https://t.test", c: [t("two")] }),
    ]);
    expect(md("see https://b.test/x.", "gfm")).toEqual([p(t("see "), { t: "link", url: "https://b.test/x", c: [t("https://b.test/x")] }, t("."))]);
    expect(md("see https://b.test/x")).toEqual([p(t("see https://b.test/x"))]);
  });

  it("reads emphasis, strong, strike and code spans", () => {
    expect(md("*a* _b_ **c** __d__ ***e***")).toEqual([
      p(
        { t: "em", c: [t("a")] },
        t(" "),
        { t: "em", c: [t("b")] },
        t(" "),
        { t: "strong", c: [t("c")] },
        t(" "),
        { t: "strong", c: [t("d")] },
        t(" "),
        { t: "strong", c: [{ t: "em", c: [t("e")] }] },
      ),
    ]);
    expect(md("**a *b* c**")).toEqual([p({ t: "strong", c: [t("a "), { t: "em", c: [t("b")] }, t(" c")] })]);
    expect(md("snake_case_word and 2 * 3 * 4")).toEqual([p(t("snake_case_word and 2 * 3 * 4"))]);
    expect(md("~~gone~~", "gfm")).toEqual([p({ t: "strike", c: [t("gone")] })]);
    expect(md("~~kept~~")).toEqual([p(t("~~kept~~"))]);
    expect(md("`a` and ``b ` c`` and ` x `")).toEqual([p({ t: "code", v: "a" }, t(" and "), { t: "code", v: "b ` c" }, t(" and "), { t: "code", v: "x" })]);
    expect(md("`unclosed")).toEqual([p(t("`unclosed"))]);
  });

  it("handles escapes and entities", () => {
    expect(plainText(fromMarkdown("\\*not\\* &amp; &#65; &lt;b&gt;", "commonmark"))).toBe("*not* & A <b>");
  });

  it("reads mentions and emoji shortcodes for gfm only", () => {
    expect(md("hi @octo-cat, :+1: and :smile:!", "gfm")).toEqual([
      p(t("hi "), { t: "mention", name: "octo-cat", id: "octo-cat" }, t(", "), { t: "emoji", v: ":+1:" }, t(" and "), { t: "emoji", v: ":smile:" }, t("!")),
    ]);
    expect(md("mail me@host.test or `@code`", "gfm")).toEqual([p(t("mail me@host.test or "), { t: "code", v: "@code" })]);
    expect(plainText(fromMarkdown("hi @octo :smile:", "commonmark"))).toBe("hi @octo :smile:");
    expect(md("at 10:30:45 ok", "gfm")).toEqual([p(t("at 10:30:45 ok"))]);
  });

  it("drops inline html but keeps its text, and maps br", () => {
    expect(md("a <b>bold</b> c<br>d <!-- hidden --> e")).toEqual([p(t("a bold c"), { t: "br" }, t("d  e"))]);
    expect(plainText(fromMarkdown("x <script>alert(1)</script> y <style>.a{}</style>z", "gfm"))).toBe("x  y z");
    expect(md('<img src="a.png" alt="A">')).toEqual([{ t: "image", name: "a.png", alt: "A" }]);
  });

  it("keeps GLFM math as inline code", () => {
    expect(md("area $a^2$ and costs $5 or $6", "glfm")).toEqual([p(t("area "), { t: "code", v: "a^2" }, t(" and costs $5 or $6"))]);
  });

  it("never throws on odd input", () => {
    for (const s of ["[", "![", "[a](", "[a](<b", "**", "`", "<", "<a", "&", "> ", "- ", "1.", "|a|\n|-|", "```", "[x]: ", "\u0000", "~~", "$"]) {
      for (const f of ["commonmark", "gfm", "glfm"] as const) expect(() => fromMarkdown(s, f)).not.toThrow();
    }
    expect(fromMarkdown("", "gfm").blocks).toEqual([]);
  });
});

describe("fromHtml", () => {
  const h = (s: string) => fromHtml(s).blocks;

  it("reads paragraphs, breaks, headings and marks", () => {
    expect(h("<h2>T</h2><p>a <b>b</b> <i>c</i> <s>d</s> <code>e</code><br>f</p>")).toEqual([
      { t: "h", level: 2, c: [t("T")] },
      p(t("a "), { t: "strong", c: [t("b")] }, t(" "), { t: "em", c: [t("c")] }, t(" "), { t: "strike", c: [t("d")] }, t(" "), { t: "code", v: "e" }, { t: "br" }, t("f")),
    ]);
    expect(h("<strong>s</strong><em>e</em><del>x</del><strike>y</strike>")[0]).toMatchObject({ t: "p" });
  });

  it("reads links and images", () => {
    expect(h('<p><a href="https://x.test/?a=1&amp;b=2">go</a></p>')).toEqual([p({ t: "link", url: "https://x.test/?a=1&b=2", c: [t("go")] })]);
    expect(h('<img src="https://i.test/a.png" alt="pic">')).toEqual([{ t: "image", url: "https://i.test/a.png", alt: "pic" }]);
    expect(h('<p>x <img src="a.png"> y</p>')).toEqual([p(t("x")), { t: "image", url: "a.png" }, p(t("y"))]);
  });

  it("reads lists, nested lists and task items", () => {
    expect(h("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>")).toEqual([
      { t: "list", ordered: false, items: [item(p(t("a")), { t: "list", ordered: false, items: [item(p(t("b")))] }), item(p(t("c")))] },
    ]);
    expect(h("<ol><li>one<li>two</ol>")).toEqual([{ t: "list", ordered: true, items: [item(p(t("one"))), item(p(t("two")))] }]);
    expect(h('<ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox"> todo</li></ul>')).toEqual([
      { t: "list", ordered: false, items: [{ checked: true, c: [p(t("done"))] }, { checked: false, c: [p(t("todo"))] }] },
    ]);
  });

  it("reads pre with a language, and quotes", () => {
    expect(h('<pre><code class="language-ts">let a &lt; 1;\n</code></pre>')).toEqual([{ t: "code", lang: "ts", v: "let a < 1;" }]);
    expect(h("<pre>a\n  b</pre>")).toEqual([{ t: "code", v: "a\n  b" }]);
    expect(h("<blockquote><p>q</p><blockquote>n</blockquote></blockquote>")).toEqual([{ t: "quote", c: [p(t("q")), { t: "quote", c: [p(t("n"))] }] }]);
  });

  it("reads tables and rules", () => {
    expect(h("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2<td>3</tr></tbody></table><hr>")).toEqual([
      {
        t: "table",
        header: true,
        rows: [
          [[t("A")], [t("B")]],
          [[t("1")], [t("2")], [t("3")]],
        ],
      },
      { t: "hr" },
    ]);
    expect(h("<table><tr><td>x</td></tr></table>")[0]).toMatchObject({ header: false });
  });

  it("treats div, span and section as transparent and collapses whitespace", () => {
    expect(h("<div>a</div><div>b <span>  c\n\n d </span></div>")).toEqual([p(t("a")), p(t("b c d"))]);
    expect(h("<section><p>x</p></section>")).toEqual([p(t("x"))]);
  });

  it("decodes entities", () => {
    expect(plainText(fromHtml("<p>&amp; &lt; &gt; &quot; &#39; &nbsp;| &#x41;&#66; &unknown;</p>"))).toBe("& < > \" ' | AB &unknown;");
  });

  it("closes unclosed and misnested tags", () => {
    expect(h("<p>one<p>two")).toEqual([p(t("one")), p(t("two"))]);
    expect(h("<b>bold <i>both</b> tail</i>")[0]).toMatchObject({ t: "p" });
    expect(plainText(fromHtml("a < b and <3"))).toBe("a < b and <3");
  });

  it("drops scripts, styles and embeds with their content", () => {
    const doc = fromHtml(
      '<p>keep</p><script>var secret = "<b>x</b>"; alert(1)</script><style>.a { color: red }</style><iframe src="x">frame text</iframe><object>obj</object><embed src="e"><template>tpl</template><svg><text>svgtext</text></svg><p>end</p>',
    );
    const text = plainText(doc);
    expect(text).toBe("keep\n\nend");
    for (const leak of ["secret", "alert", "color", "frame", "obj", "tpl", "svgtext"]) expect(text).not.toContain(leak);
  });

  it("drops an unclosed script to the end and handles odd casing", () => {
    expect(plainText(fromHtml("ok<SCRIPT>evil()"))).toBe("ok");
    expect(plainText(fromHtml("ok<ScRiPt >evil()</SCRIPT >after"))).toBe("okafter");
  });

  it("keeps only src and alt of an image with event handlers", () => {
    const d = fromHtml('<img src="https://i.test/a.png" alt="A" onerror="alert(1)" onload=steal()>');
    expect(d.blocks).toEqual([{ t: "image", url: "https://i.test/a.png", alt: "A" }]);
    expect(JSON.stringify(d)).not.toContain("alert");
    expect(JSON.stringify(d)).not.toContain("steal");
  });

  it("keeps a javascript: href raw for the renderer to filter", () => {
    expect(h('<a href="javascript:alert(1)">x</a>')).toEqual([p({ t: "link", url: "javascript:alert(1)", c: [t("x")] })]);
  });

  it("never throws or hangs on nasty input", () => {
    for (const s of ["<", "<a", '<a href="', "<<<<<", "</p></p>", "<!--", "<!doctype", "<p ", "&#xZZ;", "<ul><li><ul><li>", "<td>x", "\u0000"]) {
      expect(() => fromHtml(s)).not.toThrow();
    }
    const deep = "<div>".repeat(5000) + "x";
    expect(plainText(fromHtml(deep))).toBe("x");
    expect(() => fromHtml("<a ".repeat(3000))).not.toThrow();
    expect(fromHtml("").blocks).toEqual([]);
  });
});

describe("toRichDoc", () => {
  it("dispatches on the body kind and format", () => {
    expect(toRichDoc(null)).toEqual({ v: 1, blocks: [] });
    expect(toRichDoc({ kind: "structured", format: "adf", payload: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "adf" }] }] }, preview: "p" }).blocks).toEqual([p(t("adf"))]);
    expect(toRichDoc({ kind: "structured", format: "rich", payload: null, preview: "# H" }).blocks).toEqual([{ t: "h", level: 1, c: [t("H")] }]);
    expect(toRichDoc({ kind: "text", format: "jira-wiki", text: "h1. W" }).blocks).toEqual([{ t: "h", level: 1, c: [t("W")] }]);
    expect(toRichDoc({ kind: "text", format: "gfm", text: "- [x] a" }).blocks[0]).toMatchObject({ t: "list" });
    expect(toRichDoc({ kind: "text", format: "glfm", text: "@bob" }).blocks).toEqual([p({ t: "mention", name: "bob", id: "bob" })]);
    expect(toRichDoc({ kind: "text", format: "commonmark", text: "a" }).blocks).toEqual([p(t("a"))]);
    expect(toRichDoc({ kind: "text", format: "html", text: "<p>h</p>" }).blocks).toEqual([p(t("h"))]);
  });

  it("maps textile through the wiki reader", () => {
    const d = toRichDoc({ kind: "text", format: "textile", text: 'h2. Head\n\np. A *bold* word and "link":https://x.test.\n\n* one\n* two\n\nbc. code line\nsecond\n\nafter' });
    expect(d.blocks[0]).toEqual({ t: "h", level: 2, c: [t("Head")] });
    expect(d.blocks[1]).toEqual(p(t("A "), { t: "strong", c: [t("bold")] }, t(" word and "), { t: "link", url: "https://x.test.", c: [t("link")] }));
    expect(d.blocks[2]).toMatchObject({ t: "list" });
    expect(d.blocks[3]).toEqual({ t: "code", v: "code line\nsecond" });
    expect(d.blocks[4]).toEqual(p(t("after")));
  });

  it("splits plain text into paragraphs with breaks", () => {
    expect(toRichDoc({ kind: "text", format: "plain", text: "a\nb\r\n\r\n\nc" }).blocks).toEqual([p(t("a"), { t: "br" }, t("b")), p(t("c"))]);
    expect(toRichDoc({ kind: "text", format: "plain", text: "  " }).blocks).toEqual([]);
  });
});

describe("robustness", () => {
  const rnd = (seed: number) => {
    let s = seed;
    return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  };
  const alphabet = ["*", "_", "-", "+", "{", "}", "[", "]", "(", ")", "|", "!", "`", "<", ">", "&", "#", "\n", " ", "a", "b", "http://x.y", ":", "~", "\\", "\"", "'", "=", "/", "1.", "h1. ", "{code}", "</p>", "<p>", "&amp;"];

  it("never throws on random strings in any converter", () => {
    const r = rnd(42);
    for (let k = 0; k < 300; k++) {
      let s = "";
      for (let j = Math.floor(r() * 60); j > 0; j--) s += alphabet[Math.floor(r() * alphabet.length)];
      expect(() => fromJiraWiki(s)).not.toThrow();
      expect(() => fromMarkdown(s, "glfm")).not.toThrow();
      expect(() => fromMarkdown(s, "commonmark")).not.toThrow();
      expect(() => fromHtml(s)).not.toThrow();
      expect(() => fromAdf(s)).not.toThrow();
    }
  });

  it("stays fast on pathological repetitions", () => {
    const start = Date.now();
    const big = 5000;
    for (const unit of ["*a ", "_a ", "[a|", "![", "`a", "<a ", "- ", "> ", "||", "{panel}", "h1. *", "**a *b "]) {
      const s = unit.repeat(big);
      fromJiraWiki(s);
      fromMarkdown(s, "gfm");
      fromHtml(s);
    }
    // Backtracking would take minutes; a loaded machine only seconds.
    expect(Date.now() - start).toBeLessThan(15000);
  });

  it("keeps the same words across converters", () => {
    const words = "alpha beta gamma";
    expect(plainText(fromJiraWiki(words))).toBe(words);
    expect(plainText(fromMarkdown(words, "gfm"))).toBe(words);
    expect(plainText(fromHtml(`<p>${words}</p>`))).toBe(words);
    expect(plainText(fromAdf({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: words }] }] }))).toBe(words);
  });
});

describe("what the old wiki reader did, still done", () => {
  const links = (doc: ReturnType<typeof fromJiraWiki>) =>
    doc.blocks.flatMap((b) => (b.t === "p" ? b.c.filter((i) => i.t === "link").map((i) => (i.t === "link" ? i.url : "")) : []));
  it("[text|url], [url] and bare URLs, punctuation left to the sentence", () => {
    expect(links(fromJiraWiki("See [the sheet|https://docs.google.com/x] and [https://drive.google.com/y]."))).toEqual(["https://docs.google.com/x", "https://drive.google.com/y"]);
    expect(links(fromJiraWiki("look at https://x.it/a/b, then (https://y.it/c)."))).toEqual(["https://x.it/a/b", "https://y.it/c"]);
  });
  it("an image on another site is an address, a local one an attachment; colour macros go, code stays", () => {
    const doc = fromJiraWiki("Log in {color:#ffab00}/opt/logs{color}\n{code:sql}SELECT 1{code}\n!https://cdn.x.it/a/photo.png! and !shot.png|thumbnail!");
    expect(plainText(doc)).toContain("Log in /opt/logs");
    expect(doc.blocks).toContainEqual({ t: "code", lang: "sql", v: "SELECT 1" });
    expect(doc.blocks).toContainEqual(expect.objectContaining({ t: "image", url: "https://cdn.x.it/a/photo.png" }));
    expect(doc.blocks).toContainEqual(expect.objectContaining({ t: "image", name: "shot.png" }));
  });
});
