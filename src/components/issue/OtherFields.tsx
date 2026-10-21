import { trpc } from "@/lib/trpc";
import { PanelSection } from "@/components/app/Panel";
import { t } from "@/i18n";

/**
 * The issue's fields inkledger doesn't map (custom fields, milestone…), as
 * its tracker names them, read-only. Hidden when there are none; the last
 * copy, marked as such, when the tracker can't be reached.
 */
export function OtherFields({ issueKey, connectionId }: { issueKey: string; connectionId?: number | null }) {
  const read = trpc.issues.otherFields.useQuery({ key: issueKey, connectionId: connectionId ?? undefined }, { retry: false, staleTime: 60_000 });
  if (!read.data?.fields.length) return null;
  return (
    <PanelSection title={t("views.issue.otherFields.title")} className="border-t">
      {read.data.stale && <p className="mb-2 text-caption text-muted-foreground">{t("views.issue.otherFields.stale")}</p>}
      <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body-sm">
        {read.data.fields.map(f => (
          <div key={f.name} className="contents">
            <dt className="truncate text-muted-foreground">{f.name}</dt>
            <dd className="break-words">{f.value}</dd>
          </div>
        ))}
      </dl>
    </PanelSection>
  );
}
