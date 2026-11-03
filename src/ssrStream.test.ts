import { createElement as h, lazy, Suspense, type ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAllReady } from "./ssrStream";

const soon = <T>(value: T) => new Promise<T>(resolve => queueMicrotask(() => resolve(value)));
const loaded = <P extends object>(c: ComponentType<P>) => () => soon({ default: c });

afterEach(() => vi.restoreAllMocks());

describe("renderAllReady", () => {
  it("renders concurrent requests sharing module-level lazies once each, whole", async () => {
    // The app's shape: a lazy route, the layout's Suspense, a lazy page, a lazy part.
    const Part = lazy(loaded(() => h("p", null, "part")));
    const Page = lazy(loaded(() => h("div", null, "x".repeat(2000), h(Suspense, { fallback: null }, h(Part)))));
    const Layout = lazy(loaded(() => h("main", null, h(Suspense, { fallback: h("b", null, "spin") }, h(Page)))));
    const tree = h(Suspense, { fallback: h("b", null, "spin") }, h(Layout));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const pages = await Promise.all([0, 1, 2].map(i => new Promise(r => setTimeout(r, i)).then(() => renderAllReady(tree))));

    expect(errors).not.toHaveBeenCalled();
    for (const html of pages) {
      expect(html).toContain("<p>part</p>");
      expect(html).not.toContain("spin");
    }
  });
});
