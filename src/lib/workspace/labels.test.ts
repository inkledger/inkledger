import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocaleSource, type Locale } from "@contracts/i18n";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import { anchorLabel, controlLabel } from "./labels";

vi.mock("@/i18n", async () => ({ t: (await import("@contracts/i18n")).t }));

describe("catalog names in Settings > Workspace", () => {
  afterEach(() => setLocaleSource(() => undefined));
  for (const locale of ["en", "it"] as const satisfies readonly Locale[]) {
    it(`names every control and block without a raw placeholder in ${locale}`, () => {
      setLocaleSource(() => locale);
      const names = [...CATALOG_V1.controls.map(control => controlLabel(control.id)), ...CATALOG_V1.anchors.map(anchor => anchorLabel(anchor.id))];
      expect(names.filter(name => /\{\w+\}|\(\)/.test(name) || !name.trim())).toEqual([]);
    });
  }

  it("names a per-issue control by what it does", () => {
    expect(controlLabel("board.card.start")).toBe("Start timer");
    expect(controlLabel("dashboard.tasks.more")).toBe("Show all");
    expect(controlLabel("dashboard.timer.logStopped")).toBe("To log");
  });
});
