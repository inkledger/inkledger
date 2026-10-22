import { readStored, writeStored } from "@/lib/storage";

/**
 * This device's id: what it remembers for itself on the server (its active
 * bucket). Kept in localStorage; a fresh one when storage is unavailable
 * (private window), which then simply has no remembered choice.
 */
const KEY = "ikl-device-id";
let fallback: string | null = null;

export function deviceId(): string {
  const known = readStored(KEY);
  if (known) return known;
  if (fallback) return fallback;
  const made = crypto.randomUUID();
  // Not stored: the same one for this page.
  return writeStored(KEY, made) ? made : (fallback = made);
}
