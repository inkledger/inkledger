import { describe, expect, it } from "vitest";
import { chordLabel, chordProblem, parseChord } from "./moduleCommands";
import { moduleCommandSchema } from "./modulesSchema";

describe("module keyboard chords", () => {
  it("Mod with Shift and/or Alt, then two different letters or digits", () => {
    expect(parseChord("Mod+Shift+K+B")).toEqual({ shift: true, alt: false, first: "K", second: "B" });
    expect(chordProblem("Mod+Shift+K+B")).toBeNull();
    expect(chordProblem("Mod+Alt+1+2")).toBeNull();
    expect(chordProblem("Mod+Shift+K+K")).toBe("same-key");
    for (const bad of ["Shift+K+B", "Mod+Shift+K", "Mod+Shift+k+b", "Mod+Shift+K+B+C", "Ctrl+Shift+K+B", "Mod+Shift+Enter+B"]) expect(chordProblem(bad), bad).toBe("syntax");
  });

  it("refused where a step is the app's (plain Mod: the palette's ⌘K, copy, paste) or the browser's (closing, new windows, devtools)", () => {
    expect(chordProblem("Mod+K+B")).toBe("plain-mod");
    // ⌘⇧W closes the window before the page hears it, on either press.
    expect(chordProblem("Mod+Shift+W+E")).toBe("reserved");
    expect(chordProblem("Mod+Shift+K+W")).toBe("reserved");
    for (const k of ["Mod+Shift+T+B", "Mod+Shift+N+B", "Mod+Shift+Q+B", "Mod+Alt+I+B", "Mod+Shift+3+B"]) expect(chordProblem(k), k).toBe("reserved");
  });

  it("as the manifest declares it (a dotted, camelCase id)", () => {
    expect(moduleCommandSchema.safeParse({ id: "kanbunny.showWays", keys: "Mod+Shift+K+B", label: { en: "Show where it can go", it: "Mostra dove può andare" } }).success).toBe(true);
    expect(moduleCommandSchema.safeParse({ id: "kanbunny.showWays", keys: "Mod+Shift+W+E", label: { en: "x", it: "x" } }).success).toBe(false);
  });

  it("written as the platform writes it", () => {
    expect(chordLabel("Mod+Shift+K+B", true)).toEqual(["⌘", "⇧", "K", "B"]);
    expect(chordLabel("Mod+Shift+Alt+K+B", false)).toEqual(["Ctrl", "Shift", "Alt", "K", "B"]);
  });
});
