/**
 * Round k holds each id's k-th copy, in list order: within a round, no id appears twice.
 * A list that names the same thing more than once is then applied round after round, each
 * copy finding what the one before it left, as one by one did; an ordinary list is one round.
 */
export function rounds<T>(all: T[], idOf: (t: T) => string): T[][] {
  const seen = new Map<string, number>();
  const out: T[][] = [];
  for (const t of all) {
    const id = idOf(t);
    const k = seen.get(id) ?? 0;
    seen.set(id, k + 1);
    (out[k] ??= []).push(t);
  }
  return out;
}
