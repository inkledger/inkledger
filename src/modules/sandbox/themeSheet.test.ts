import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fontFaces, fontLoader, THEME_TOKENS, themeSheet } from "./themeSheet";

describe("the app's look in a frame", () => {
  it("sends every design token of the app's :root", () => {
    const css = fs.readFileSync(path.resolve(import.meta.dirname, "../../index.css"), "utf8");
    const start = css.indexOf(":root {");
    const block = css.slice(start, css.indexOf("\n  }", start));
    const names = new Set([...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]));
    expect(names.size).toBeGreaterThan(40);
    expect([...names].filter(n => !(THEME_TOKENS as readonly string[]).includes(n ?? ""))).toEqual([]);
  });

  it("tokens as they resolve now, the density's font size, never a value that ends the rule", () => {
    const sheet = themeSheet({
      token: n => (n === "--primary" ? " 16 60% 45% " : n === "--card" ? "0 0% 100%}body{display:none" : ""),
      fontFamily: '"Inter Variable", system-ui, sans-serif',
      fontSize: "14px",
    });
    expect(sheet).toBe(':root{--primary:16 60% 45%}html{font-size:14px;}body{font-family:"Inter Variable", system-ui, sans-serif;}');
    expect(sheet).not.toContain("color-scheme");
  });

  it("fonts inline, encoded once for every frame", async () => {
    let reads = 0;
    const load = fontLoader([{ family: "Inter Variable", url: "/f.woff2" }], async () => (reads++, new Blob([new Uint8Array([1, 2, 3])])));
    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe(b);
    expect(reads).toBe(1);
    expect(a).toContain("@font-face{font-family:'Inter Variable';");
    expect(a).toContain("url(data:font/woff2;base64,AQID)");
    expect(fontFaces([{ family: "x');}*{", data: "data:font/woff2;base64,AQID" }])).toBe("");
  });
});
