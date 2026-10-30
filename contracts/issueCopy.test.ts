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
});
