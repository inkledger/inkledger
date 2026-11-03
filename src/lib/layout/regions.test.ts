import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { REGION_REM, regionSize } from "./regions";
import { PANE_L_REM, PANE_M_REM } from "@/components/issue/paneSize";

describe("the spatial system's region sizes", () => {
  it("are the ones Tailwind's @m/@l/@xl variants write, and a desk pane's", () => {
    const config = readFileSync("tailwind.config.js", "utf8");
    for (const [name, rem] of Object.entries(REGION_REM)) {
      expect(config).toContain(`addVariant("@${name}", "@container region (min-width: ${rem}rem)")`);
    }
    expect([PANE_M_REM, PANE_L_REM]).toEqual([REGION_REM.m, REGION_REM.l]);
  });

  it("follow the root font: the same width is a size smaller in comfortable density", () => {
    // 420 px: 30rem at the compact 14 px root (m), 26.25rem at the comfortable 16 px (s).
    expect(regionSize(420, 14)).toBe("m");
    expect(regionSize(420, 16)).toBe("s");
    expect(regionSize(840, 14)).toBe("l");
    expect(regionSize(840, 16)).toBe("m");
    expect(regionSize(1200, 14)).toBe("xl");
    expect(regionSize(1200, 16)).toBe("l");
  });
});
