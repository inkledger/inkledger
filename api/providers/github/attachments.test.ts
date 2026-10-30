// Images pasted into a GitHub issue, shared with an agent through the app (docs/work/ideas/issue-copy.md R-6.9).
import { describe, expect, it, vi } from "vitest";
import { issueMarkdown } from "@contracts/issueCopy";
import { mapUrls } from "@contracts/richtext";
import { toRichDoc } from "../core/richtext";
import { githubSimulator } from "./simulator";
import { bodyAttachments, fetchGitHubAttachment } from "./attachments";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "140.82.112.6", family: 4 }]) }));

const PNG = new Uint8Array([137, 80, 78, 71]);

describe("GitHub attachments", () => {
  it("GitHub images are shared through the app", async () => {
    const sim = githubSimulator();
    const pasted = sim.upload("0b1c2d3e-1111-4222-8333-444455556666", PNG);
    const file = "https://github.com/user-attachments/files/17/trace.log";
    const issue = sim.add("acme/web", "Broken", { body: `Look:\n\n<img width="300" alt="shot" src="${pasted}">\n\nAnd [the log](${file}).` });
    const key = `acme/web#${issue.number}`;
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization") });
      return sim.fetch(input, init);
    });
    try {
      const body = issue.body ?? "";
      expect(bodyAttachments(body)).toEqual([
        { url: pasted, name: "image-0b1c2d3e" },
        { url: file, name: "trace.log" },
      ]);
      // In the copied text: the app's links, never GitHub's or its token.
      const shared = (url: string) => `https://app.test/api/shared/${encodeURIComponent(url).length}`;
      const links = new Map(bodyAttachments(body).map((a) => [a.url, shared(a.url)]));
      const doc = mapUrls(toRichDoc({ kind: "text", format: "gfm", text: body }), (u) => links.get(u) ?? null);
      const md = issueMarkdown({ key, title: "Broken", url: issue.html_url, status: "Open", type: null }, doc, bodyAttachments(body).map((a) => ({ name: a.name, url: links.get(a.url)! })));
      expect(md).toContain(`![shot](${shared(pasted)})`);
      expect(md).toContain(`[the log](${shared(file)})`);
      expect(md).not.toContain("user-attachments");
      expect(md).not.toContain("gho_");
      // Downloaded: through the issue's signed body_html, the token only to the API.
      const res = await fetchGitHubAttachment({ apiBase: sim.apiBase, token: "gho_secret" }, key, pasted);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
      const fileCall = calls.find((c) => c.url.startsWith("https://private-user-images.githubusercontent.com/"));
      expect(fileCall?.auth).toBeNull();
      expect(calls.filter((c) => c.auth !== null).every((c) => c.url.startsWith(sim.apiBase))).toBe(true);
      // A link no longer in the issue (edited away) opens nothing.
      await expect(fetchGitHubAttachment({ apiBase: sim.apiBase, token: "gho_secret" }, key, "https://github.com/user-attachments/assets/0b1c2d3e-9999-4222-8333-444455556666")).rejects.toMatchObject({ kind: "notFound" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
