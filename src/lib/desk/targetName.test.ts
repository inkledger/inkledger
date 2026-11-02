import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESETS, presetsFor, snapTargets } from "@contracts/desk";
import { loadLocale, setLocaleSource, type Locale } from "@contracts/i18n";
import { placeOf, placeShortName, targetName } from "./targetName";

vi.mock("@/i18n", async () => ({ t: (await import("@contracts/i18n")).t }));

const speak = async (locale: Locale) => {
  await loadLocale(locale);
  setLocaleSource(() => locale);
};

describe("target names", () => {
  afterEach(() => setLocaleSource(() => undefined));

  it("says halves, columns, corners and the big one as a person would", () => {
    const keys = ["DEMO-101", "DEMO-102", "DEMO-103"];
    expect(targetName({ kind: "slot", preset: "cols-2", slot: 1 }, keys)).toBe("right half");
    expect(targetName({ kind: "slot", preset: "rows-2", slot: 0 }, keys)).toBe("top half");
    expect(targetName({ kind: "slot", preset: "cols-3", slot: 2 }, keys)).toBe("third column");
    expect(targetName({ kind: "slot", preset: "main-left", slot: 0 }, keys)).toBe("big on the left");
    expect(targetName({ kind: "slot", preset: "main-left", slot: 1 }, keys)).toBe("top right corner, with the big one on the left");
    expect(targetName({ kind: "slot", preset: "quad", slot: 1 }, keys)).toBe("top right corner");
    expect(targetName({ kind: "swap", index: 2 }, keys)).toBe("in place of DEMO-103");
    expect(placeShortName(placeOf("main-bottom", 2))).toBe("top right corner");
    expect(targetName({ kind: "slot", preset: "single", slot: 0 }, keys)).toBe("the whole desk");
  });

  it("names every place for a pane count differently, in English and Italian", async () => {
    for (const locale of ["en", "it"] as const) {
      await speak(locale);
      for (const n of [2, 3, 4]) {
        const names = snapTargets(n).map(target => targetName(target, []));
        expect(new Set(names).size, `${locale}, ${n} panes: ${names.join(" | ")}`).toBe(names.length);
        expect(names.every(name => name.length > 0 && !name.includes("pages.desk"))).toBe(true);
      }
    }
    expect(targetName({ kind: "slot", preset: "cols-2", slot: 0 }, [])).toBe("metà sinistra");
  });

  it("places the big one first and its small ones on the other side", () => {
    for (const preset of presetsFor(3)) {
      const places = Array.from({ length: PRESETS[preset].slots }, (_, slot) => placeOf(preset, slot));
      if (preset === "cols-3") expect(places.map(place => place.kind)).toEqual(["column", "column", "column"]);
      else expect(places.map(place => place.kind)).toEqual(["big", "beside", "beside"]);
    }
  });
});
