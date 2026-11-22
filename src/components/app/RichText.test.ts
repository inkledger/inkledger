// What the Desk chat draws of a model's answer: a model can be steered by the text it
// reads, so nothing in an answer may load from elsewhere by itself.
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fromMarkdown } from "../../../api/providers/core/richtext";
import { RichText } from "./RichText";

// The link itself (it asks before opening a site not allowed yet): a plain anchor here.
vi.mock("./ExternalLink", () => ({ ExternalLink: ({ url, children }: { url: string; children: ReactNode }) => createElement("a", { href: url }, children) }));

describe("RichText as the Desk chat draws an answer", () => {
  it("an image from elsewhere is a link to click, never loaded", () => {
    const doc = fromMarkdown("Found it.\n\n![chart](https://elsewhere.example/p.png?d=APP-1%20secret)\n\nSee [the log](https://elsewhere.example/?q=secret).", "gfm");
    const html = renderToStaticMarkup(createElement(RichText, { doc, images: new Map(), variant: "document", headingLevel: 3 }));
    expect(html).not.toMatch(/<img|<iframe|<video|<audio|<source|<link|srcset|background/i);
    expect(html).toContain("elsewhere.example");
  });
});
