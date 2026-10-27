import { describe, expect, it } from "vitest";
import { sceneList, stepScene } from "./registry";

const mods = [
  { id: "bonsai", name: { en: "Bonsai", it: "Bonsai" }, slots: ["screensaver"] },
  { id: "city", name: { en: "City Window", it: "Finestra sulla città" }, slots: ["dashboard-backdrop"] },
  { id: "shadow", name: { en: "Shadow", it: "Ombra" }, slots: ["screensaver", "settings"] },
];

describe("sceneList", () => {
  it("lists built-ins first and only mods offering the screensaver slot", () => {
    const list = sceneList(mods, "it", key => key);
    expect(list[0]).toEqual({ id: "ink", label: "ui.screensaver.scene.ink" });
    expect(list.slice(1)).toEqual([
      { id: "mod:bonsai", label: "Bonsai", mod: "bonsai" },
      { id: "mod:shadow", label: "Ombra", mod: "shadow" },
    ]);
  });
});

describe("stepScene", () => {
  const list = sceneList(mods, "en", key => key);

  it("moves in both directions with wrapping", () => {
    expect(stepScene(list, "ink", -1)?.id).toBe("mod:shadow");
    expect(stepScene(list, "mod:shadow", 1)?.id).toBe("ink");
    expect(stepScene(list, "ink", 2)?.id).toBe("mod:shadow");
  });

  it("falls back to the first scene for an unknown id", () => {
    expect(stepScene(list, "removed-scene", 1)?.id).toBe("ink");
    expect(stepScene([], "ink", 1)).toBeUndefined();
  });
});
