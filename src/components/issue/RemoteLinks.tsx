import { Link2 } from "lucide-react";
import { surface } from "@/components/app/surface";
import { trpc } from "@/lib/trpc";
import { PanelSection } from "@/components/app/Panel";
import { ExternalLink } from "@/components/app/ExternalLink";
import { t } from "@/i18n";

/**
 * The issue's links to other services (Confluence, Drive, …): Jira remote
 * links, read live. Hidden when there are none; each opens only if its
 * domain is allowed (or after asking).
 */
export function RemoteLinks({ issueKey, connectionId }: { issueKey: string; connectionId?: number | null }) {
  const links = trpc.issues.remoteLinks.useQuery({ key: issueKey, connectionId: connectionId ?? undefined }, { retry: false, staleTime: 60_000 });
  if (!links.data?.length) return null;
  return (
    <PanelSection title={t("views.issue.links.title")} className="border-t">
      <ul className="grid gap-2">
        {links.data.map(l => (
          <li key={l.id} className="flex min-w-0 items-start gap-2.5">
            <span aria-hidden {...surface("picture")} className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Link2 className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <ExternalLink url={l.url} className="font-medium">
                {l.title}
              </ExternalLink>
              <p className="truncate text-caption text-muted-foreground">
                {[l.app, new URL(l.url).hostname].filter(Boolean).join(" · ")}
                {l.summary ? ` — ${l.summary}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </PanelSection>
  );
}
