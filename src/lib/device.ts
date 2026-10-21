/**
 * This device's id: what it remembers for itself on the server (its active
 * bucket). Kept in localStorage; a fresh one when storage is unavailable
 * (private window), which then simply has no remembered choice.
 */
const KEY = "ikl-device-id";
let fallback: string | null = null;

export function deviceId(): string {
  try {
    const known = localStorage.getItem(KEY);
    if (known) return known;
    const made = crypto.randomUUID();
    localStorage.setItem(KEY, made);
    return made;
  } catch {
    return (fallback ??= crypto.randomUUID());
  }
}
