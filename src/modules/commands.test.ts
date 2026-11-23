import { describe, expect, it } from "vitest";
import { CHORD_GAP_MS } from "@contracts/moduleCommands";
import { createChordMatcher, watchCommands, type RunningCommand } from "./commands";

const showWays: RunningCommand = { id: "kanbunny.showWays", keys: "Mod+Shift+K+B", label: { en: "Show", it: "Mostra" }, moduleId: "kanbunny", moduleName: { en: "Kanbunny", it: "Kanbunny" } };
const body = { tagName: "BODY", isContentEditable: false } as unknown as EventTarget;
const mac = (code: string, more: Partial<KeyboardEvent> = {}) => ({ code, metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, repeat: false, target: body, ...more });

function setup(apple = true) {
  let now = 0;
  const m = createChordMatcher([showWays], apple, () => now);
  return { m, at: (t: number) => void (now = t) };
}

describe("module keyboard commands: the chord", () => {
  it("K then B with ⌘⇧ held: both keys swallowed, the command on B", () => {
    const { m, at } = setup();
    expect(m.keydown(mac("KeyK"))).toEqual({ swallow: true, run: [] });
    at(200);
    expect(m.keydown(mac("KeyB"))).toEqual({ swallow: true, run: [showWays] });
  });

  it("order counts: B then K is nothing, and nothing is swallowed", () => {
    const { m } = setup();
    expect(m.keydown(mac("KeyB"))).toEqual({ swallow: false, run: [] });
    expect(m.keydown(mac("KeyK")).run).toEqual([]);
  });

  it("B past the gap, K let go: nothing (a Mac sends no keyup under ⌘, so held means K still repeating)", () => {
    const { m, at } = setup();
    m.keydown(mac("KeyK"));
    at(CHORD_GAP_MS + 1);
    expect(m.keydown(mac("KeyB")).run).toEqual([]);
  });

  it("K held (repeating) past the gap, then B: the command", () => {
    const { m, at } = setup();
    m.keydown(mac("KeyK"));
    for (let t = 500; t <= 1500; t += 33) {
      at(t);
      m.keydown(mac("KeyK", { repeat: true }));
    }
    at(1520);
    expect(m.keydown(mac("KeyB")).run).toEqual([showWays]);
  });

  it("the modifiers exactly: Shift let go, Alt added, Ctrl on a Mac or Meta elsewhere is another chord", () => {
    const { m } = setup();
    m.keydown(mac("KeyK"));
    m.keyup({ code: "ShiftLeft" });
    expect(m.keydown(mac("KeyB")).run).toEqual([]);
    m.keydown(mac("KeyK"));
    expect(m.keydown(mac("KeyB", { altKey: true })).run).toEqual([]);
    expect(m.keydown(mac("KeyK", { ctrlKey: true })).swallow).toBe(false);
    const pc = setup(false).m;
    expect(pc.keydown(mac("KeyK")).swallow).toBe(false);
    pc.keydown(mac("KeyK", { metaKey: false, ctrlKey: true }));
    expect(pc.keydown(mac("KeyB", { metaKey: false, ctrlKey: true })).run).toEqual([showWays]);
  });

  it("another key between K and B breaks it", () => {
    const { m } = setup();
    m.keydown(mac("KeyK"));
    m.keydown(mac("KeyJ"));
    expect(m.keydown(mac("KeyB")).run).toEqual([]);
  });

  it("never while typing in a field or contenteditable", () => {
    const { m } = setup();
    const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
    const editable = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
    expect(m.keydown(mac("KeyK", { target: input }))).toEqual({ swallow: false, run: [] });
    expect(m.keydown(mac("KeyB", { target: input })).run).toEqual([]);
    m.keydown(mac("KeyK", { target: editable }));
    expect(m.keydown(mac("KeyB", { target: editable })).run).toEqual([]);
  });
});

describe("module keyboard commands: on the window", () => {
  it("listens in capture and stops the keys there (⌘⇧K never reaches the palette's shortcut)", () => {
    const fns = new Map<string, { fn: (e: KeyboardEvent) => void; capture: unknown }>();
    const win = { addEventListener: (t: string, fn: (e: KeyboardEvent) => void, capture?: unknown) => fns.set(t, { fn, capture }), removeEventListener: (t: string) => fns.delete(t) } as unknown as Window;
    const told: string[] = [];
    const off = watchCommands(win, [showWays], true, c => told.push(c.id));
    expect(fns.get("keydown")?.capture).toBe(true);
    const stopped: string[] = [];
    const ev = (code: string) => ({ ...mac(code), preventDefault: () => stopped.push(`prevent ${code}`), stopPropagation: () => stopped.push(`stop ${code}`) }) as unknown as KeyboardEvent;
    fns.get("keydown")?.fn(ev("KeyK"));
    fns.get("keydown")?.fn(ev("KeyB"));
    expect(stopped).toEqual(["prevent KeyK", "stop KeyK", "prevent KeyB", "stop KeyB"]);
    expect(told).toEqual(["kanbunny.showWays"]);
    off();
    expect(fns.size).toBe(0);
  });
});
