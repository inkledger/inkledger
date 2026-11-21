import { describe, expect, it } from "vitest";
import { jsonForHtml, ssrDocument } from "./ssr";
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

describe("SSR page", () => {
  it("keeps dollar signs in issue titles as they are (no replacement patterns)", () => {
    const index = '<!doctype html><html lang="en"><head><title>inkledger</title></head><body><div id="root"></div><script src="/a.js"></script></body></html>';
    const title = "fix $` and $' and $& and $$ in the regex";
    const payload = jsonForHtml({ title });
    const html = ssrDocument(index, { locale: "it", app: `<p>${title}</p>`, layout: "", payload });
    expect(html).toContain(`<p>${title}</p>`);
    const state = /<script id="inkledger-ssr-state" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1] ?? "";
    expect(JSON.parse(state)).toEqual({ title });
    expect(html.match(/<html lang=/g)).toHaveLength(1);
    expect(html).toContain('<html lang="it">');
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
