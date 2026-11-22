import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { lazyPart } from "./lazyPart";

const Body = () => createElement("p", null, "body");
const settle = () => new Promise(r => setTimeout(r, 0));

describe("a part kept out of the first load", () => {
  it("fetches nothing while it is closed", () => {
    const load = vi.fn(() => Promise.resolve(Body));
    const Part = lazyPart(load, () => false);
    expect(renderToString(createElement(Part))).toBe("");
    expect(load).not.toHaveBeenCalled();
  });

  it("fetches its code again when opened after a failed fetch", async () => {
    const load = vi.fn<() => Promise<typeof Body>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
      .mockResolvedValue(Body);
    const Part = lazyPart(load);
    renderToString(createElement(Part));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    renderToString(createElement(Part));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(renderToString(createElement(Part))).toContain("body");
  });
});
