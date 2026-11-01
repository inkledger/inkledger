const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
};

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("workspace canon v1: expected a safe integer");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) {
    return `[${value.map(item => {
      if (item === undefined) throw new Error("workspace canon v1: undefined array item");
      return canonicalJSON(item);
    }).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    // NFC before sorting: "é" and "e\u0301" are one key, and two such keys are refused, not both written.
    const entries = Object.keys(value).filter(key => value[key] !== undefined).map(key => [key.normalize("NFC"), key] as const);
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    for (let index = 1; index < entries.length; index++) {
      if (entries[index][0] === entries[index - 1][0]) throw new Error("workspace canon v1: keys equal after NFC");
    }
    return `{${entries.map(([normalized, key]) => `${JSON.stringify(normalized)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  throw new Error(`workspace canon v1: unsupported value (${typeof value})`);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJSON(value));
}

export function domainSeparatedBytes(kind: string, value: unknown): Uint8Array {
  const context = new TextEncoder().encode(`inkledger-workspace-${kind}-v1\n`);
  const body = canonicalBytes(value);
  const result = new Uint8Array(context.length + body.length);
  result.set(context);
  result.set(body, context.length);
  return result;
}

export function sortByStableId<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  const sorted = items.map((item, index) => ({ item, id: idOf(item), index }));
  const ids = new Set<string>();
  for (const { id } of sorted) {
    if (!id) throw new Error("workspace canon v1: empty stable id");
    if (ids.has(id)) throw new Error(`workspace canon v1: duplicate stable id ${id}`);
    ids.add(id);
  }
  sorted.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.index - b.index));
  return sorted.map(({ item }) => item);
}

export function hexOf(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
