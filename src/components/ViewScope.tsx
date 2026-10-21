import { Layers, Search } from "lucide-react";
import { useBuckets } from "@/hooks/useBuckets";
import { ToggleChip } from "@/components/app/ToggleChip";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";

/**
 * What Timesheet and Report count (D9): this device's bucket, or All; and a
 * search in the query language over the worklogs' issues.
 */
export function ViewScope({
  all,
  onAll,
  search,
  onSearch,
  unsupported = [],
}: {
  all: boolean;
  onAll: (all: boolean) => void;
  search: string;
  onSearch: (search: string) => void;
  /** Terms of the search the server couldn't apply */
  unsupported?: string[];
}) {
  const { active } = useBuckets();
  return (
    <div className="mb-3 grid gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {active && (
          <div role="group" aria-label={t("ui.viewScope.label")} className="flex gap-1">
            <ToggleChip size="sm" pressed={!all} onClick={() => onAll(false)}>
              <Layers className="h-3.5 w-3.5" aria-hidden />
              {active.name}
            </ToggleChip>
            <ToggleChip size="sm" pressed={all} onClick={() => onAll(true)}>
              {t("ui.viewScope.all")}
            </ToggleChip>
          </div>
        )}
        <div className="relative min-w-48 flex-1 sm:max-w-80">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            className="h-8 pl-8"
            value={search}
            onChange={e => onSearch(e.target.value)}
            placeholder={t("ui.viewScope.searchPlaceholder")}
            aria-label={t("ui.viewScope.searchLabel")}
          />
        </div>
      </div>
      {unsupported.length > 0 && (
        <p role="status" className="text-caption text-muted-foreground">
          {t("views.issues.filters.queryUnsupported", { terms: unsupported.join(" ") })}
        </p>
      )}
    </div>
  );
}
