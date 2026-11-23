import { useSyncExternalStore } from "react";
import { CHORD_GAP_MS, parseChord, type Chord } from "@contracts/moduleCommands";
import type { ModuleCommand } from "@contracts/modules";
import { isTyping } from "@/lib/dom";

// Framed modules' keyboard commands: the host matches the chords on the window
// and tells the module's views page event "command" (the palette sends the same).

export type RunningCommand = ModuleCommand & { moduleId: string; moduleName: { en: string; it: string } };

type Key = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat" | "target">;

/** A letter or digit by where it is on the keyboard (Alt changes what `key` says on a Mac). */
const keyOf = (code: string): string | null => /^(?:Key([A-Z])|Digit(\d))$/.exec(code)?.slice(1).find(Boolean) ?? null;
const MODIFIERS = new Set(["MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight"]);

/**
 * Matches chords over keydown/keyup: the modifiers held exactly (the command key: Meta on Apple
 * devices, Ctrl elsewhere), the first key, then the second while the first is held or within
 * CHORD_GAP_MS. A Mac sends no keyup for a letter while Meta is down, so "held" lasts only as
 * long as the first key keeps repeating. `keydown` says whether the key is the chord's (the
 * host swallows it) and which commands it completes.
 */
export function createChordMatcher(commands: readonly RunningCommand[], apple: boolean, now: () => number = () => performance.now()) {
  const chords = commands.flatMap(c => {
    const chord = parseChord(c.keys);
    return chord ? [{ c, chord }] : [];
  });
  let pending: { first: string; shift: boolean; alt: boolean; at: number } | null = null;
  const modsOf = (e: Key): { shift: boolean; alt: boolean } | null =>
    (apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) ? { shift: e.shiftKey, alt: e.altKey } : null;
  const same = (a: Pick<Chord, "shift" | "alt">, b: Pick<Chord, "shift" | "alt">) => a.shift === b.shift && a.alt === b.alt;
  return {
    keydown(e: Key): { swallow: boolean; run: RunningCommand[] } {
      const none = { swallow: false, run: [] };
      if (isTyping(e.target)) return ((pending = null), none);
      const mods = modsOf(e);
      const key = keyOf(e.code);
      if (!mods || !key) return MODIFIERS.has(e.code) ? none : ((pending = null), none);
      const t = now();
      if (pending && key === pending.first && same(pending, mods)) {
        // Still held: its repeats keep the chord open.
        if (e.repeat) pending.at = t;
        return { swallow: true, run: [] };
      }
      if (pending && same(pending, mods) && t - pending.at <= CHORD_GAP_MS) {
        const p = pending;
        const run = chords.filter(({ chord }) => chord.first === p.first && chord.second === key && same(chord, mods)).map(x => x.c);
        if (run.length) return ((pending = null), { swallow: true, run });
      }
      const starts = chords.some(({ chord }) => chord.first === key && same(chord, mods));
      pending = starts ? { first: key, ...mods, at: t } : null;
      return { swallow: starts, run: [] };
    },
    keyup(e: Pick<KeyboardEvent, "code">) {
      // A modifier let go ends the chord; the first key let go leaves its gap to run out.
      if (MODIFIERS.has(e.code)) pending = null;
    },
    reset() {
      pending = null;
    },
  };
}

/** Commands told to a module's views (page events), none held for a late listener. */
export function createCommandSignals() {
  const listeners = new Map<string, Set<(id: string) => void>>();
  return {
    tell(moduleId: string, id: string) {
      for (const fn of listeners.get(moduleId) ?? []) fn(id);
    },
    subscribe(moduleId: string, fn: (id: string) => void): () => void {
      const fns = listeners.get(moduleId) ?? new Set();
      listeners.set(moduleId, fns);
      fns.add(fn);
      return () => void fns.delete(fn);
    },
  };
}

export const commandSignals = createCommandSignals();

/** Listens on the window (capture, before the app's own shortcuts) while some running module has commands. Returns the undo. */
export function watchCommands(win: Pick<Window, "addEventListener" | "removeEventListener">, commands: readonly RunningCommand[], apple: boolean, tell: (c: RunningCommand) => void): () => void {
  if (commands.length === 0) return () => {};
  const m = createChordMatcher(commands, apple);
  const down = (e: KeyboardEvent) => {
    const r = m.keydown(e);
    if (!r.swallow) return;
    // Its first key too: ⌘⇧K would open the palette, whose shortcut ignores Shift.
    e.preventDefault();
    e.stopPropagation();
    r.run.forEach(tell);
  };
  const up = (e: KeyboardEvent) => m.keyup(e);
  const blur = () => m.reset();
  win.addEventListener("keydown", down, true);
  win.addEventListener("keyup", up, true);
  win.addEventListener("blur", blur);
  return () => {
    win.removeEventListener("keydown", down, true);
    win.removeEventListener("keyup", up, true);
    win.removeEventListener("blur", blur);
  };
}

// The running modules' commands, for the shortcuts help and the palette.
let running: readonly RunningCommand[] = [];
const watchers = new Set<() => void>();
export const runningCommands = {
  set(next: readonly RunningCommand[]) {
    running = next;
    watchers.forEach(w => w());
  },
  get: () => running,
};

export function useRunningCommands(): readonly RunningCommand[] {
  return useSyncExternalStore(
    w => {
      watchers.add(w);
      return () => watchers.delete(w);
    },
    () => running,
    () => running,
  );
}
