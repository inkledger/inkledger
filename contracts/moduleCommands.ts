/**
 * A framed module's keyboard commands ("commands" in its signed manifest): a
 * four-key chord, the platform's command key plus Shift and/or Alt held, then
 * two letters or digits ("Mod+Shift+K+B": ⌘⇧ on Apple devices, Ctrl+Shift
 * elsewhere). The host listens and tells the module's views page event
 * `{ kind: "command", id }`.
 */

/** At most this many commands a module. */
export const COMMANDS_MAX = 4;
/** The second key counts within this long of the first (or while the first is still held). */
export const CHORD_GAP_MS = 600;

export const COMMAND_ID = /^[a-z0-9][a-z0-9.-]{0,31}$/i;
const CHORD = /^Mod\+(Shift\+)?(Alt\+)?([A-Z0-9])\+([A-Z0-9])$/;

export type Chord = { shift: boolean; alt: boolean; first: string; second: string };

/**
 * Each step the chord presses (its modifiers plus one key) the browser, the OS or the app
 * keeps for itself, by modifiers: closing or opening windows and tabs, devtools, redo,
 * screenshots. Plain Mod (the app's palette ⌘K, copy, paste…) is refused whole.
 */
const RESERVED: Record<string, readonly string[]> = {
  "Mod+Shift": ["W", "T", "N", "Q", "Z", "R", "P", "I", "J", "C", "M", "A", "3", "4", "5"],
  "Mod+Alt": ["I", "J", "C", "U", "H", "M", "W", "N"],
  "Mod+Shift+Alt": ["I", "J", "C", "Q", "V"],
};

const modsOf = (c: { shift: boolean; alt: boolean }) => `Mod${c.shift ? "+Shift" : ""}${c.alt ? "+Alt" : ""}`;

/** A chord as written, or null when it is not one. */
export function parseChord(keys: string): Chord | null {
  const m = CHORD.exec(keys);
  if (!m?.[3] || !m[4]) return null;
  return { shift: !!m[1], alt: !!m[2], first: m[3], second: m[4] };
}

/** Why a manifest's chord is refused, or null when it may be used. */
export function chordProblem(keys: string): "syntax" | "plain-mod" | "same-key" | "reserved" | null {
  const c = parseChord(keys);
  if (!c) return "syntax";
  if (!c.shift && !c.alt) return "plain-mod";
  if (c.first === c.second) return "same-key";
  const taken = RESERVED[modsOf(c)] ?? [];
  return taken.includes(c.first) || taken.includes(c.second) ? "reserved" : null;
}

/** The chord's keys as the platform writes them (for help and the Store). */
export function chordLabel(keys: string, apple: boolean): string[] {
  const c = parseChord(keys);
  if (!c) return [keys];
  return [apple ? "⌘" : "Ctrl", ...(c.shift ? [apple ? "⇧" : "Shift"] : []), ...(c.alt ? [apple ? "⌥" : "Alt"] : []), c.first, c.second];
}
