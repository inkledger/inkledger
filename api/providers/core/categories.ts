// The category of a status, where the service doesn't say it: from the
// connection's own mapping (its options), or from a native status's name.
import type { StatusCategory } from "@contracts/providers";
import { mappingId, mappingVersion } from "../types";

/**
 * A category the connection's options gave: its origin. The options are the
 * connection's category mapping until the engine's own mapping table exists:
 * id = the connection, version 1.
 */
export const connectionMapping = (connId: number) => ({ by: "mapping" as const, mapping: mappingId(connId), version: mappingVersion(1) });

/** The category the options give a column (section, list): by its id, else by its name in any case, else "todo". */
export function mappedCategory(categories: Record<string, StatusCategory>, column: { id: string; name: string }): StatusCategory {
  const byId = categories[column.id];
  if (byId) return byId;
  const name = column.name.trim().toLowerCase();
  const hit = Object.entries(categories).find(([k]) => k.toLowerCase() === name);
  return hit ? hit[1] : "todo";
}

/** A status the service only calls closed or open: closed is done unless its name says cancelled, open is doing when its name says so, else todo. */
export const categoryByName = (name: string, closed: boolean, words: { cancelled: RegExp; doing: RegExp }): StatusCategory =>
  closed ? (words.cancelled.test(name) ? "cancelled" : "done") : words.doing.test(name) ? "doing" : "todo";
