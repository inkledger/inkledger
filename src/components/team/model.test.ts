import { describe, expect, it } from "vitest";
import resolveConfig from "tailwindcss/resolveConfig";
import { STEP_CLASS } from "./model";

describe("the heat map's steps", () => {
  // A fill with an opacity off the scale makes no CSS at all: the cell is transparent, read as "off" (2 Nov).
  it("use only opacities on Tailwind's scale, so every step is drawn", () => {
    // The app's config keeps Tailwind's opacity scale (tailwind.config.js extends no opacity).
    const scale = Object.keys(resolveConfig({ content: [] }).theme.opacity);
    for (const [step, classes] of Object.entries(STEP_CLASS)) {
      for (const [, opacity] of classes.matchAll(/\/(\d+)\b/g)) expect(scale, `${step}: /${opacity}`).toContain(opacity);
    }
  });
});
