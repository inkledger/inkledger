import { trpc } from "@/lib/trpc";
import { RichText } from "@/components/app/RichText";
import { EmptyState, ErrorState } from "@/components/app/States";
import { Skeleton } from "@/components/ui/skeleton";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";

/** The issue's description as written on its tracker, in whatever markup it uses. */
export function DescriptionSection({ issueKey, connectionId }: { issueKey: string; connectionId?: number | null }) {
  const provider = useProviderName(connectionId);
  const description = trpc.issues.description.useQuery(
    { key: issueKey, connectionId: connectionId ?? undefined },
    { retry: false, staleTime: 60_000 }
  );
  // Same cached query as the attachments section: resolves !image.png! embeds.
  const attachments = trpc.issues.attachments.useQuery(
    { key: issueKey, connectionId: connectionId ?? undefined },
    { retry: false }
  );
  const images = new Map((attachments.data ?? []).map(a => [a.filename, a.id]));

  if (description.isPending) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (description.error) {
    return (
      <ErrorState
        message={description.error.message}
        onRetry={() => description.refetch()}
      />
    );
  }
  if (!description.data.text) {
    return (
      <EmptyState
        art="doc"
        title={t("views.issue.description.empty", { provider })}
        className="py-6"
      />
    );
  }
  return (
    <RichText
      doc={description.data.doc}
      images={images}
      connectionId={connectionId}
      collapseAfter={1200}
    />
  );
}
