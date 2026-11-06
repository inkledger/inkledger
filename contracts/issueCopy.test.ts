// An issue copied for an agent (docs/work/ideas/issue-copy.md R-6.1).
import { describe, expect, it } from "vitest";
import { issueMarkdown } from "./issueCopy";

describe("issueMarkdown", () => {
  it("an issue copies with its header and attachments", () => {
    const md = issueMarkdown(
      { key: "APP-7", title: "Export *fails*", url: "https://jira.example/browse/APP-7", status: "In Progress", type: "Bug" },
      { v: 1, blocks: [{ t: "p", c: [{ t: "text", v: "It breaks:" }] }, { t: "image", name: "shot.png" }] },
      [
        { name: "shot.png", url: "https://app.test/api/shared/t1" },
        { name: "trace.log", url: "https://app.test/api/shared/t2" },
        { name: "shot.png", url: "https://app.test/api/shared/t1" },
      ],
    );
    expect(md).toMatchInlineSnapshot(`
      "# APP-7: Export \\*fails\\*

      - Tracker: https://jira.example/browse/APP-7
      - Status: In Progress
      - Type: Bug

      ## Description

      It breaks:

      ![shot.png](https://app.test/api/shared/t1)

      ## Attachments

      - [shot.png](https://app.test/api/shared/t1)
      - [trace.log](https://app.test/api/shared/t2)
      "
    `);
    // No description, no type, no attachments: said plainly, nothing empty.
    expect(issueMarkdown({ key: "GH-1", title: "T", url: "https://x/1", status: "Open", type: null }, { v: 1, blocks: [] }, [])).toBe(
      "# GH-1: T\n\n- Tracker: https://x/1\n- Status: Open\n\n## Description\n\n(no description)\n",
    );
  });

  it("comments copy oldest first, their images linked like the description's", () => {
    const at = new Date(2026, 10, 5, 9, 30).getTime();
    const p = (v: string) => ({ v: 1 as const, blocks: [{ t: "p" as const, c: [{ t: "text" as const, v }] }] });
    const md = issueMarkdown(
      { key: "APP-8", title: "T", url: "https://x/8", status: "Open", type: null },
      p("Body"),
      [{ name: "shot.png", url: "https://app.test/api/shared/t1" }],
      1,
      [
        { author: "Anna_B", created: at, doc: { v: 1, blocks: [{ t: "image", name: "shot.png" }] } },
        { author: "Luca", created: null, doc: { v: 1, blocks: [] } },
      ],
    );
    expect(md).toContain("## Description\n\nBody\n\n## Comments\n\n### Anna\\_B · 2026-11-05 09:30\n\n![shot.png](https://app.test/api/shared/t1)\n\n### Luca\n\n(empty)\n\n## Attachments");
    // Inside another prompt: two levels deeper.
    expect(issueMarkdown({ key: "A-1", title: "T", url: "u", status: "s", type: null }, p("x"), [], 3, [{ author: "A", created: null, doc: p("hi") }])).toContain("#### Comments\n\n##### A\n\nhi");
    // None: no section; not readable now: said, the rest still copied.
    expect(issueMarkdown({ key: "A-1", title: "T", url: "u", status: "s", type: null }, p("x"), [])).not.toContain("Comments");
    expect(issueMarkdown({ key: "A-1", title: "T", url: "u", status: "s", type: null }, p("x"), [], 1, "unavailable")).toContain("## Comments\n\n(comments unavailable)\n");
  });
});
