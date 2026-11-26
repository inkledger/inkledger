import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicLinks } from "./PublicLinks";
import { publicRefs } from "./labels";

// Allowed: drawn as a plain link (the lock popover is ExternalLink's own business).
vi.mock("@/hooks/useAllowedLinks", () => ({ useAllowedLinks: () => ({ isAllowed: () => true, allow: async (h: string) => h }) }));

const none = { publicIssueUrl: null, publicIssueState: null, publicPrUrl: null, publicPrState: null };
const issue = "https://github.com/inkledger/inkledger/issues/123";
const pr = "https://github.com/inkledger/inkledger/pull/124";

describe("feedback made public", () => {
  it("nothing when the developers made nothing public", () => {
    expect(publicRefs(none)).toBeNull();
    expect(renderToStaticMarkup(createElement(PublicLinks, { feedback: none }))).toBe("");
  });

  it("the public issue and the draft proposal, with their states", () => {
    expect(publicRefs({ ...none, publicIssueUrl: issue, publicIssueState: "open" })).toEqual({ issue: { url: issue, label: "#123" }, pr: null });
    const open = publicRefs({ publicIssueUrl: issue, publicIssueState: "open", publicPrUrl: pr, publicPrState: "open" });
    expect(open?.pr?.url).toBe(pr);
    expect(open?.pr?.label).toMatch(/124/);
    const merged = publicRefs({ publicIssueUrl: issue, publicIssueState: "closed", publicPrUrl: pr, publicPrState: "merged" });
    expect(merged?.issue.label).not.toBe("#123");
    expect(merged?.pr?.label).not.toBe(open?.pr?.label);
  });

  it("draws both as links to GitHub", () => {
    const html = renderToStaticMarkup(createElement(PublicLinks, { feedback: { publicIssueUrl: issue, publicIssueState: "open", publicPrUrl: pr, publicPrState: "merged" } }));
    expect(html).toContain(`href="${issue}"`);
    expect(html).toContain(`href="${pr}"`);
    expect(html).toContain("#123");
  });
});
