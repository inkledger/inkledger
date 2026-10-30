// Rich text to Markdown (docs/work/ideas/issue-copy.md R-6.2): what an agent reads when an issue is copied for it.
import { describe, expect, it } from "vitest";
import { toMarkdown, type RichDoc } from "./richtext";

const none = () => null;

describe("toMarkdown", () => {
  it("every rich text node becomes Markdown", () => {
    const doc: RichDoc = {
      v: 1,
      blocks: [
        { t: "h", level: 2, c: [{ t: "text", v: "Steps" }] },
        {
          t: "p",
          c: [
            { t: "strong", c: [{ t: "text", v: "bold" }] },
            { t: "text", v: " " },
            { t: "em", c: [{ t: "text", v: "it" }] },
            { t: "text", v: " " },
            { t: "strike", c: [{ t: "text", v: "gone" }] },
            { t: "text", v: " " },
            { t: "code", v: "x()" },
            { t: "text", v: " " },
            { t: "link", url: "https://example.com/a", c: [{ t: "text", v: "site" }] },
            { t: "text", v: " " },
            { t: "mention", name: "Ada" },
            { t: "text", v: " " },
            { t: "emoji", v: "🙂" },
            { t: "br" },
            { t: "text", v: "next" },
          ],
        },
        { t: "code", lang: "ts", v: "const a = 1;" },
        {
          t: "list",
          ordered: false,
          items: [
            { checked: null, c: [{ t: "p", c: [{ t: "text", v: "one" }] }] },
            {
              checked: null,
              c: [
                { t: "p", c: [{ t: "text", v: "two" }] },
                { t: "list", ordered: true, items: [{ checked: null, c: [{ t: "p", c: [{ t: "text", v: "inner" }] }] }] },
              ],
            },
          ],
        },
        {
          t: "list",
          ordered: false,
          items: [
            { checked: true, c: [{ t: "p", c: [{ t: "text", v: "done" }] }] },
            { checked: false, c: [{ t: "p", c: [{ t: "text", v: "open" }] }] },
          ],
        },
        { t: "quote", c: [{ t: "p", c: [{ t: "text", v: "said" }] }] },
        {
          t: "table",
          header: true,
          rows: [
            [[{ t: "text", v: "A" }], [{ t: "text", v: "B" }]],
            [[{ t: "text", v: "1" }], [{ t: "text", v: "x|y" }]],
          ],
        },
        { t: "hr" },
        { t: "image", url: "https://example.com/p.png", alt: "pic" },
        { t: "panel", kind: "warning", c: [{ t: "p", c: [{ t: "text", v: "careful" }] }] },
      ],
    };
    expect(toMarkdown(doc, none)).toBe(
      [
        "## Steps",
        "**bold** *it* ~~gone~~ `x()` [site](https://example.com/a) @Ada 🙂  \nnext",
        "```ts\nconst a = 1;\n```",
        "- one\n- two\n  1. inner",
        "- [x] done\n- [ ] open",
        "> said",
        "| A | B |\n| --- | --- |\n| 1 | x\\|y |",
        "---",
        "![pic](https://example.com/p.png)",
        "> **Warning:**\n> careful",
      ].join("\n\n"),
    );
  });

  it("Markdown characters and fences are safe", () => {
    const doc: RichDoc = {
      v: 1,
      blocks: [
        { t: "p", c: [{ t: "text", v: "a *b* _c_ [d] # e <f> `g`" }] },
        { t: "p", c: [{ t: "code", v: "a`b" }] },
        { t: "code", v: "```\ninside\n```" },
        { t: "p", c: [{ t: "text", v: "# not a heading" }] },
        { t: "p", c: [{ t: "text", v: "1. not a list" }] },
      ],
    };
    expect(toMarkdown(doc, none)).toBe(
      [
        "a \\*b\\* \\_c\\_ \\[d\\] # e \\<f\\> \\`g\\`",
        "`` a`b ``",
        "````\n```\ninside\n```\n````",
        "\\# not a heading",
        "1\\. not a list",
      ].join("\n\n"),
    );
  });

  it("attachments become links only when they resolve", () => {
    const link = (name: string) => (name === "shot.png" || name === "log.txt" ? `https://app.test/api/shared/${name}` : null);
    const doc: RichDoc = {
      v: 1,
      blocks: [
        { t: "image", name: "shot.png" },
        { t: "image", name: "lost.png", alt: "lost" },
        { t: "p", c: [{ t: "text", v: "see " }, { t: "attachment", name: "log.txt" }, { t: "text", v: " and " }, { t: "attachment", name: "old.zip" }] },
      ],
    };
    expect(toMarkdown(doc, link)).toBe(
      [
        "![shot.png](https://app.test/api/shared/shot.png)",
        "[attachment: lost.png]",
        "see [log.txt](https://app.test/api/shared/log.txt) and [attachment: old.zip]",
      ].join("\n\n"),
    );
  });
});
