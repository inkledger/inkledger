// Jira's priorities in its own order (highest first), as ranks 0–4: read
// once a day per site, best effort (a failure leaves ranks unknown).
import type { JiraCredentials } from "@contracts/types";
import { priorityRankOf } from "@contracts/categories";
import { fetchPriorities } from "./client";

const DAY_MS = 24 * 3600_000;
const cache = new Map<string, { at: number; ranks: Map<string, number | null> }>();

export async function priorityRanks(creds: JiraCredentials): Promise<Map<string, number | null> | null> {
  const hit = cache.get(creds.siteUrl);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.ranks;
  try {
    const list = await fetchPriorities(creds);
    const ranks = new Map(list.map((p, i) => [p.name, priorityRankOf(i, list.length)]));
    cache.set(creds.siteUrl, { at: Date.now(), ranks });
    return ranks;
  } catch {
    return hit?.ranks ?? null;
  }
}

/** The ranks read for a site, without asking Jira (undefined: not read yet). */
export const knownRanks = (siteUrl: string) => cache.get(siteUrl)?.ranks;

/** Tests: forget what was read. */
export const forgetPriorityRanks = () => cache.clear();
