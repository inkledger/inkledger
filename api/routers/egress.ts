import { desc } from "drizzle-orm";
import { createRouter, permProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { connections, egressHosts } from "@db/schema";
import { env } from "../lib/env";
import { flushEgress } from "../lib/egress";
import { PROVIDER_NAMES } from "@contracts/providerNames";
import type { ProviderType } from "@contracts/providers";

/** What a host is called for: a tracker (its name), or one of the services the server uses itself. */
export type EgressPurpose = { kind: "tracker"; name: string } | { kind: "microsoft" | "github" | "weather" | "store" | "other" };

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/** Settings → Network: every host the server has called out to, what for, how often and how it went. */
export const egressRouter = createRouter({
  list: permProcedure("manageServer").query(async () => {
    await flushEgress();
    const db = getDb();
    const [rows, trackers] = await Promise.all([
      db.select().from(egressHosts).orderBy(desc(egressHosts.lastAt)),
      db.selectDistinct({ type: connections.type, baseUrl: connections.baseUrl }).from(connections),
    ]);
    const tracker = new Map<string, string>();
    for (const c of trackers) {
      const h = hostOf(c.baseUrl);
      if (h) tracker.set(h, c.type in PROVIDER_NAMES ? PROVIDER_NAMES[c.type as ProviderType] : c.type);
    }
    const store = env.storeUrl ? hostOf(env.storeUrl) : null;
    const purposeOf = (host: string): EgressPurpose => {
      const name = tracker.get(host);
      if (name) return { kind: "tracker", name };
      if (/(^|\.)(microsoftonline\.com|graph\.microsoft\.com|office\.com|office365\.com|cloud\.microsoft)$/.test(host)) return { kind: "microsoft" };
      if (/(^|\.)github(usercontent)?\.com$/.test(host)) return { kind: "github" };
      if (/(^|\.)open-meteo\.com$/.test(host)) return { kind: "weather" };
      if (host === store) return { kind: "store" };
      return { kind: "other" };
    };
    return rows.map(r => ({ ...r, purpose: purposeOf(r.host) }));
  }),
});
