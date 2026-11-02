/** The strings of a JSON array kept as text; anything else (malformed, not an array) reads as none. */
export function parseStringList(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
