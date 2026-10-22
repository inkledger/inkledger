import { failureText } from "@/lib/errorText";
import { useCallback, useMemo } from "react";
import { hostAllowed, normalizeDomain } from "@contracts/links";
import { trpc } from "@/lib/trpc";
import { useTrackerSites } from "@/hooks/useConnections";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * Which external links open freely: the user's allowed domains (Settings →
 * Link esterni) plus every connected tracker's site. Allow/remove save at once.
 */
export function useAllowedLinks() {
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  const trackers = useTrackerSites();
  const domains = useMemo(() => settings.data?.allowedLinkDomains ?? [], [settings.data]);
  const trackerHosts = useMemo(() => trackers.map(s => s.host.replace(/:\d+$/, "")), [trackers]);

  const update = trpc.settings.update.useMutation({
    onSuccess: data => utils.settings.get.setData(undefined, data),
    onError: e => toast.error(t("ui.allowed.saveFailed", { message: failureText(e) })),
  });

  const isAllowed = useCallback(
    (url: string) => {
      try {
        const u = new URL(url);
        if (u.protocol === "mailto:") return true;
        return hostAllowed(u.hostname, [...domains, ...trackerHosts]);
      } catch {
        return false;
      }
    },
    [domains, trackerHosts]
  );

  const allow = useCallback(
    async (input: string) => {
      const d = normalizeDomain(input);
      if (!d) throw new Error(t("ui.allowed.invalid"));
      if (domains.includes(d)) return d;
      await update.mutateAsync({ allowedLinkDomains: [...domains, d] });
      return d;
    },
    [domains, update]
  );

  const remove = useCallback(
    (d: string) => update.mutate({ allowedLinkDomains: domains.filter(x => x !== d) }),
    [domains, update]
  );

  return { domains, trackers, isAllowed, allow, remove, loading: settings.isPending, error: settings.error, refetch: settings.refetch };
}
