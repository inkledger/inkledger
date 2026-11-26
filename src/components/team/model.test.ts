import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "tailwindcss";
import { STEP_CLASS } from "./model";

describe("the heat map's steps", () => {
  // A fill with an opacity off the scale made no CSS at all: the cell was transparent, read as "off" (2 Nov).
  it("each make CSS with the app's theme, so every step is drawn", async () => {
    const css = readFileSync("src/index.css", "utf8");
    const colours = /@theme inline \{[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
    expect(colours).toContain("--color-primary:");
    const compiler = await compile(`${colours}\n@tailwind utilities;`);
    const none = compiler.build([]);
    for (const [step, classes] of Object.entries(STEP_CLASS)) {
      for (const cls of classes.split(" ").filter(Boolean)) {
        // A pattern of index.css's own (not a utility).
        if (cls === "stripes-idle") expect(css).toContain(".stripes-idle {");
        else expect(compiler.build([cls]).length, `${step}: ${cls}`).toBeGreaterThan(none.length);
      }
    }
  });
});
