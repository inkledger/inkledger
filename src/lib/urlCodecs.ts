import { dayKey, parseDayKey } from "@contracts/time";

/** How one value lives in the query string ("" = present without a value). */
export type Codec<T> = { parse: (raw: string) => T | null; format: (v: T) => string };

export const text: Codec<string> = { parse: s => s, format: v => v };

/** Present = true ("?favorites"), absent = false. */
export const flag: Codec<boolean> = { parse: () => true, format: () => "" };

/** "1" / "0": a yes/no whose default may be yes (unlike `flag`). */
export const bool: Codec<boolean> = {
  parse: s => (s === "1" ? true : s === "0" ? false : null),
  format: v => (v ? "1" : "0"),
};

export const int: Codec<number> = {
  parse: s => (/^\d+$/.test(s) ? Number(s) : null),
  format: v => String(v),
};

export function oneOf<T extends string>(values: readonly T[]): Codec<T> {
  return { parse: s => (values.includes(s as T) ? (s as T) : null), format: v => v };
}

/** A local day as "2026-10-16". */
export const day: Codec<Date> = {
  parse: s => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? parseDayKey(s) : null),
  format: v => dayKey(v),
};

/** A day, or none (null = "follow today"). */
export const optionalDay: Codec<Date | null> = {
  parse: s => day.parse(s),
  format: v => (v ? day.format(v) : ""),
};

/** Sorted, comma separated ("ABC,DEF"). */
export const textSet: Codec<Set<string>> = {
  parse: s => new Set(s.split(",").filter(Boolean)),
  format: v => [...v].sort().join(","),
};

export type FieldSpec<T> = { key: string; fallback: T; codec: Codec<T> };
export type Fields<T> = { [K in keyof T]: FieldSpec<T[K]> };

/** Reads every field; a missing or malformed value is its fallback. */
export function readFields<T>(params: URLSearchParams, fields: Fields<T>): T {
  const out = {} as T;
  for (const name in fields) {
    const { key, fallback, codec } = fields[name];
    const raw = params.get(key);
    const parsed = raw === null ? null : codec.parse(raw);
    out[name] = parsed ?? fallback;
  }
  return out;
}

/** Writes a patch: a value equal to its fallback leaves the URL clean. */
export function writeFields<T>(params: URLSearchParams, fields: Fields<T>, patch: Partial<T>): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name in patch) {
    const spec = fields[name];
    const value = patch[name] as T[typeof name];
    // A flag is "on" by being there; anything else by differing from its fallback.
    const isDefault =
      spec.codec === (flag as Codec<unknown>)
        ? !value
        : spec.codec.format(value) === spec.codec.format(spec.fallback);
    if (isDefault) next.delete(spec.key);
    else next.set(spec.key, spec.codec.format(value));
  }
  return next;
}
