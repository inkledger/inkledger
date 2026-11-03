import { trpc } from "@/lib/trpc";
import { PanelSection } from "@/components/app/Panel";
import { t } from "@/i18n";

/**
 * The issue's fields inkledger doesn't map (custom fields, milestone…), as
 * its tracker names them, read-only. Hidden when there are none; the last
 * copy, marked as such, when the tracker can't be reached.
 */
export function OtherFields({
  issueKey,
  connectionId,
}: {
  issueKey: string;
  connectionId?: number | null;
}) {
  const read = trpc.issues.otherFields.useQuery(
    { key: issueKey, connectionId: connectionId ?? undefined },
    { retry: false, staleTime: 60_000 }
  );
  if (!read.data?.fields.length) return null;
  return (
    <PanelSection
      title={t("views.issue.otherFields.title")}
      className="border-t"
    >
      {read.data.stale && (
        <p className="mb-2 text-caption text-muted-foreground">
          {t("views.issue.otherFields.stale")}
        </p>
      )}
      {/* Name over value, in as many columns as the section's width holds (docs/design-system.md §7.1):
          a dozen custom fields read as a sheet, not a long two-column list. */}
      <div className="region">
        <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-2.5 text-body-sm @m:grid-cols-2 @xl:grid-cols-3">
          {read.data.fields.map(f => (
            <div key={f.name} className="min-w-0">
              <dt className="truncate text-caption text-muted-foreground" title={f.name}>{f.name}</dt>
              <dd className="[overflow-wrap:anywhere]">{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </PanelSection>
  );
}
