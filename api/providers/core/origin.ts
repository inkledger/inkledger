// Which connection a credential or an error comes from: a refusal marks
// that connection to reconnect, never the user's other ones.
const origins = new WeakMap<object, number>();

/** The value, remembered as coming from that connection. */
export function originate<T extends object>(value: T, connectionId: number): T {
  if (!origins.has(value)) origins.set(value, connectionId);
  return value;
}

/** The connection a value (credentials, an error, or its cause) comes from, when known. */
export function originOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const own = origins.get(value);
  if (own !== undefined) return own;
  return value instanceof Error && value.cause !== undefined && value.cause !== value ? originOf(value.cause) : undefined;
}
