import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "./PageHeader";

vi.mock("@/components/app/Breadcrumb", () => ({ Breadcrumb: () => null, BackButton: () => null }));

describe("PageHeader", () => {
  // A module drawn over the Dashboard (z-10) never paints over its header nor takes its clicks, on any width.
  it("a sticky header stands over modules drawn over the page", () => {
    const html = renderToStaticMarkup(createElement(PageHeader, { title: "Dashboard", sticky: true }));
    expect(html).toContain("data-above-modules");
    const classes = /class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? [];
    expect(classes).toEqual(expect.arrayContaining(["relative", "z-20", "bg-card"]));
  });
});
