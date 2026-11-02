import { describe, expect, it } from "vitest";
import { PANE_L_REM, PANE_M_REM, paneSize } from "./paneSize";

describe("paneSize", () => {
  it("is small below 28rem, medium below 56rem, large from 56rem", () => {
    expect(paneSize(PANE_M_REM * 14 - 1, 14)).toBe("s");
    expect(paneSize(PANE_M_REM * 14, 14)).toBe("m");
    expect(paneSize(PANE_L_REM * 14 - 1, 14)).toBe("m");
    expect(paneSize(PANE_L_REM * 14, 14)).toBe("l");
  });

  it("follows the root font (density): the same pixels are fewer rem when comfortable", () => {
    expect(paneSize(800, 14)).toBe("l"); // 57.1rem
    expect(paneSize(800, 16)).toBe("m"); // 50rem
    expect(paneSize(420, 14)).toBe("m"); // 30rem
    expect(paneSize(420, 16)).toBe("s"); // 26.25rem
  });

  it("reads an unknown root font as 16px", () => {
    expect(paneSize(440, 0)).toBe("s");
    expect(paneSize(460, Number.NaN)).toBe("m");
  });
});
