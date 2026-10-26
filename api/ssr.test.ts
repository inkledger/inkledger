import { describe, expect, it } from "vitest";
import { jsonForHtml } from "./ssr";
import { supportsSSR } from "./ssrQueries";

describe("SSR HTML state", () => {
  it("cannot close its data script or inject markup", () => {
    const json = jsonForHtml({ value: "</script><script>alert(1)</script>&\u2028" });
    expect(json).not.toContain("</script>");
    expect(json).not.toContain("<script>");
    expect(json).not.toContain("&");
    expect(json).not.toContain("\u2028");
    expect(JSON.parse(json)).toEqual({ value: "</script><script>alert(1)</script>&\u2028" });
  });
});

describe("SSR route manifest", () => {
  it("covers login and the dashboard day, keeping every other page on the SPA", () => {
    expect(supportsSSR(new URL("http://localhost/login"))).toBe(true);
    expect(supportsSSR(new URL("http://localhost/"))).toBe(true);
    expect(supportsSSR(new URL("http://localhost/?period=day"))).toBe(true);
    expect(supportsSSR(new URL("http://localhost/?period=week"))).toBe(false);
    expect(supportsSSR(new URL("http://localhost/?period=day&from=2026-01-01"))).toBe(false);
    expect(supportsSSR(new URL("http://localhost/?modules=off"))).toBe(false);
    expect(supportsSSR(new URL("http://localhost/issues"))).toBe(false);
  });
});
