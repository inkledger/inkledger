import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

/** The user's connections: their service's name and capabilities (the app decides by capability, never by type). */
export function useConnections() {
  return trpc.connections.list.useQuery(undefined, { staleTime: 5 * 60_000 });
}

/**
 * The name of the service an issue or action belongs to ("Jira", "GitHub"):
 * its connection's; else, for the whole app, the one service the user
 * connects, the plural word when there are several ("your trackers"), the
 * generic word when none yet. Always a name: sentences put it after a
 * preposition ("su {provider}"), which a phrase with an article can't follow.
 */
export function useProviderName(connectionId?: number | null): string {
  const list = useConnections().data ?? [];
  const own = connectionId ? list.find(c => c.id === connectionId) : undefined;
  if (own) return own.name;
  const names = new Set(
    list.filter(c => c.role === "tracker").map(c => c.name)
  );
  if (names.size > 1) return t("common.trackers");
  return [...names][0] ?? t("common.tracker");
}

/** The connection's tracker keeps no time of its own (GitHub): its worklogs live in inkledger only. */
export function useKeepsTimeHere(connectionId?: number | null): boolean {
  const own = (useConnections().data ?? []).find(c => c.id === connectionId);
  const caps = own?.capabilities;
  return !!caps && "time" in caps && caps.time.mode === "local";
}

/**
 * What an issue's tracker offers, for showing only what it can do: watch,
 * attachments, an estimate. True while the connections are loading, so
 * nothing blinks away and back.
 */
export function useTrackerOffers(connectionId?: number | null) {
  const list = useConnections().data;
  const own = list?.find(c => c.id === connectionId);
  const caps = own && own.role === "tracker" ? own.capabilities : null;
  const traits = own && "traits" in own ? own.traits : null;
  const known = !!caps;
  return {
    watch: known ? caps.watch : true,
    attachments: known && traits ? traits.attachments.read : true,
    estimate: known && traits ? traits.fields.includes("estimate") : true,
  };
}

/** The trackers' sites, as their pages open in a browser: the one made first (legacy) first. */
export function useTrackerSites(): { host: string; name: string }[] {
  const list = (useConnections().data ?? []).filter(c => c.role === "tracker");
  const sorted = [...list].sort((a, b) => Number(b.legacy) - Number(a.legacy));
  const seen = new Set<string>();
  return sorted.flatMap(c =>
    seen.has(c.webHost)
      ? []
      : (seen.add(c.webHost), [{ host: c.webHost, name: c.name }])
  );
}
