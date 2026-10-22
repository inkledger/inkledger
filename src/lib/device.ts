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
  // Kept for this page too: stored or not, read back or not, the same one until it reloads.
  fallback = crypto.randomUUID();
  writeStored(KEY, fallback);
  return fallback;
}
