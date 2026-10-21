import {
  CheckCheck,
  Eye,
  EyeOff,
  Search,
  Sparkles,
  Star,
  UserX,
} from "lucide-react";
import { surface } from "@/components/app/surface";
import { Input } from "@/components/ui/input";
import { QueryMenu } from "@/components/issues/QueryMenu";
import { QueryAssist } from "@/components/issues/QueryAssist";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ToggleChip } from "@/components/app/ToggleChip";
import { t, numberFormat } from "@/i18n";

export type SortMode = "activity" | "updated" | "priority" | "key" | "due";

export type IssueFilterState = {
  search: string;
  status: string;
  project: string;
  label: string;
  sort: SortMode;
  favOnly: boolean;
  /** Default view = open issues assigned to me */
  includeDone: boolean;
  includeUnassigned: boolean;
  /** Only the issues the user hid */
  hiddenView: boolean;
  /** Only issues with news since the last visit */
  unreadOnly: boolean;
  /** Only the issues I watch on Jira, whoever they are assigned to */
  watchingOnly: boolean;
};

export type IssueCounts = {
  done: number;
  unassigned: number;
  hidden: number;
  watching: number;
};

/** Tonal on/off chip for the view toggles. */
function Toggle({
  pressed,
  onClick,
  icon: Icon,
  label,
  count,
}: {
  pressed: boolean;
  onClick: () => void;
  icon: typeof Star;
  label: string;
  count?: number;
}) {
  return (
    <ToggleChip size="sm" pressed={pressed} onClick={onClick}>
      <Icon className={cn("h-3.5 w-3.5", pressed && "fill-current/20")} />
      {label}
      {count !== undefined && (
        <span className="tabular opacity-70">{numberFormat().format(count)}</span>
      )}
    </ToggleChip>
  );
}

const sortOptions = (): { value: SortMode; label: string }[] => [
  { value: "activity", label: t("views.issues.filters.sortActivity") },
  { value: "updated", label: t("views.issues.filters.sortUpdated") },
  { value: "priority", label: t("views.issues.filters.sortPriority") },
  { value: "key", label: t("views.issues.filters.sortKey") },
  { value: "due", label: t("views.issues.filters.sortDue") },
];

export function IssueFilters({
  filters,
  onChange,
  statuses,
  projects,
  labels,
  counts,
  unread,
  onSearchSubmit,
}: {
  filters: IssueFilterState;
  onChange: (patch: Partial<IssueFilterState>) => void;
  /** Enter in the search box (kept among the recent ones; a key or link opens its issue) */
  onSearchSubmit?: (query: string) => void;
  statuses: string[];
  projects: { key: string; name: string }[];
  labels: string[];
  counts?: IssueCounts;
  /** Open issues of mine with news (label of "News") */
  unread?: number;
}) {
  const hv = filters.hiddenView;
  return (
    // Sticks under the page header while the list scrolls (desktop).
    <div {...surface("ground")} className="mb-4 grid gap-2.5 lg:sticky lg:top-[var(--page-header-h,0px)] lg:z-10 lg:-mt-2 lg:mb-1 lg:bg-card lg:pb-3 lg:pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-full flex-1 sm:min-w-56">
          <Search
            className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            className="pl-8"
            placeholder={t("views.issues.filters.searchPlaceholder")}
            aria-label={t("views.issues.filters.searchLabel")}
            value={filters.search}
            onChange={e => onChange({ search: e.target.value })}
            onKeyDown={e => {
              if (e.key === "Enter" && filters.search.trim()) onSearchSubmit?.(filters.search.trim());
            }}
          />
        </div>
        <QueryMenu
          value={filters.search}
          onPick={q => {
            onChange({ search: q });
            onSearchSubmit?.(q);
          }}
        />
        <Select
          value={filters.status}
          onValueChange={v => onChange({ status: v })}
        >
          <SelectTrigger
            className="w-full sm:w-40"
            aria-label={t("views.issues.filters.statusLabel")}
          >
            <SelectValue placeholder={t("views.issues.filters.status")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("views.issues.filters.allStatuses")}</SelectItem>
            {statuses.map(s => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.project}
          onValueChange={v => onChange({ project: v })}
        >
          <SelectTrigger
            className="w-full sm:w-40"
            aria-label={t("views.issues.filters.projectLabel")}
          >
            <SelectValue placeholder={t("views.issues.filters.project")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("views.issues.filters.allProjects")}</SelectItem>
            {projects.map(p => (
              <SelectItem key={p.key} value={p.key}>
                {p.key} — {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.label}
          onValueChange={v => onChange({ label: v })}
        >
          <SelectTrigger
            className="w-full sm:w-36"
            aria-label={t("views.issues.filters.labelLabel")}
          >
            <SelectValue placeholder={t("views.issues.filters.label")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("views.issues.filters.allLabels")}</SelectItem>
            {labels.map(l => (
              <SelectItem key={l} value={l}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.sort}
          onValueChange={v => onChange({ sort: v as SortMode })}
        >
          <SelectTrigger className="w-full sm:w-36" aria-label={t("views.issues.filters.sortLabel")}>
            <SelectValue placeholder={t("views.issues.filters.sort")} />
          </SelectTrigger>
          <SelectContent>
            {sortOptions().map(o => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <QueryAssist value={filters.search} onChange={search => onChange({ search })} />
      <div
        role="group"
        aria-label={t("views.issues.filters.show")}
        className="flex flex-wrap items-center gap-1.5"
      >
        <Toggle
          pressed={filters.unreadOnly && !hv}
          onClick={() =>
            onChange({ unreadOnly: !filters.unreadOnly, hiddenView: false })
          }
          icon={Sparkles}
          label={t("views.issues.filters.news")}
          count={unread}
        />
        <Toggle
          pressed={filters.watchingOnly && !hv}
          onClick={() =>
            onChange({ watchingOnly: !filters.watchingOnly, hiddenView: false })
          }
          icon={Eye}
          label={t("views.issues.filters.watching")}
          count={counts?.watching}
        />
        <Toggle
          pressed={filters.favOnly && !hv}
          onClick={() =>
            onChange({ favOnly: !filters.favOnly, hiddenView: false })
          }
          icon={Star}
          label={t("views.issues.filters.favourites")}
        />
        <Toggle
          pressed={filters.includeDone && !hv}
          onClick={() =>
            onChange({ includeDone: !filters.includeDone, hiddenView: false })
          }
          icon={CheckCheck}
          label={t("views.issues.filters.showDone")}
          count={counts?.done}
        />
        <Toggle
          pressed={filters.includeUnassigned && !hv}
          onClick={() =>
            onChange({
              includeUnassigned: !filters.includeUnassigned,
              hiddenView: false,
            })
          }
          icon={UserX}
          label={t("views.issues.filters.showUnassigned")}
          count={counts?.unassigned}
        />
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <Toggle
          pressed={hv}
          onClick={() => onChange({ hiddenView: !hv })}
          icon={EyeOff}
          label={t("views.issues.filters.hidden")}
          count={counts?.hidden}
        />
      </div>
    </div>
  );
}
