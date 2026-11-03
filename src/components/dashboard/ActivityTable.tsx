import { Dot } from "@/components/app/Chip";
import { statusCategoryTone } from "@/lib/jira";
import { compare } from "./activitySort";
import { Link } from "react-router";
import { formatDurationLong } from "@contracts/time";
import { projectOf } from "@/lib/projectColors";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { EmptyState } from "@/components/app/States";
import { t, dateFormat } from "@/i18n";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { Collection } from "@/components/app/Collection";
import { StartIssueButton } from "@/components/issue/StartIssueButton";
import { surface } from "@/components/app/surface";
import { flowControlProps } from "@/lib/workspace/instrumentation";
import { issuePath, issueId } from "@/lib/issues";

export type ActivityRow = {
  issueKey: string;
  connectionId?: number | null;
  remoteId?: string | null;
  summary?: string;
  status?: string;
  /** Canonical category (contracts/categories.ts) */
  category?: string;
  lastComment: string;
  lastAt: Date;
  seconds: number;
};


const when = () => dateFormat({ weekday: "short", day: "numeric", month: "short" });

export type ActivitySort = "last" | "seconds";

/** The strip's order, in its section's header (no row of its own). */
export function ActivitySortControl({ value, onChange }: { value: ActivitySort; onChange: (sort: ActivitySort) => void }) {
  return (
    <SegmentedControl
      label={t("views.dashboard.activity.sortBy")}
      value={value}
      onChange={onChange}
      options={[
        { value: "last", label: t("views.dashboard.activity.lastActivity"), control: flowControlProps("dashboard.activity.sort") },
        { value: "seconds", label: t("views.dashboard.activity.hours"), control: flowControlProps("dashboard.activity.sort") },
      ]}
    />
  );
}

/**
 * Issues worked on recently, to pick work up again: one tile each (key, title on two lines, status, its
 * hours with a thread against the busiest, ▶ to start it). A bounded grid as wide as its block (a
 * Collection, docs/design-system.md §7.1): two rows, then "Show all N" in place. Never scrolled sideways.
 * The last activity is in the tile's tooltip and its accessible name.
 */
export function ActivityTable({ rows, sort = "last" }: { rows: ActivityRow[]; sort?: ActivitySort }) {
  const sorted = [...rows].sort((a, b) => compare(a, b, sort));
  const most = Math.max(1, ...rows.map(r => r.seconds));

  if (rows.length === 0) {
    return (
      <EmptyState
        art="calendar"
        title={t("views.dashboard.activity.empty")}
        className="py-6"
      />
    );
  }

  return (
    <Collection
      items={sorted}
      keyOf={r => issueId(r)}
      rows={2}
      maxColumns={4}
      label={t("pages.dashboard.recentActivity")}
      itemClassName="relative"
      render={r => {
        const last = `${r.lastComment || r.summary || "—"} · ${when().format(r.lastAt)}`;
        return (
          <>
            <Link
              to={issuePath({ key: r.issueKey, connectionId: r.connectionId, remoteId: r.remoteId })}
              title={last}
              {...surface("card")}
              className="relative grid h-full content-between gap-1.5 overflow-hidden rounded-xl border bg-card p-3 pb-3.5 transition-[border-color] hover:border-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex min-w-0 items-center gap-2 pr-6">
                <ProjectAvatar project={projectOf(r.issueKey)} size="xs" />
                <span className="truncate text-body-sm font-semibold">{r.issueKey}</span>
              </span>
              <span className="line-clamp-2 min-h-[2lh] [overflow-wrap:anywhere] text-body-sm text-muted-foreground">{r.summary}</span>
              <span className="flex min-w-0 items-center justify-between gap-2 text-caption text-muted-foreground">
                <span className="flex min-w-0 items-center gap-1.5">
                  {r.status && <Dot tone={statusCategoryTone(r.category ?? "")} className="h-1.5 w-1.5" />}
                  <span className="truncate">{r.status}</span>
                </span>
                <span className="shrink-0 tabular font-medium text-foreground">{formatDurationLong(r.seconds)}</span>
              </span>
              {/* Its hours against the busiest issue's, as a thread along the tile's edge: the colour is the data. */}
              <span aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-muted">
                <span className="block h-full rounded-r-full bg-primary" style={{ width: `${Math.max(4, (r.seconds / most) * 100)}%` }} />
              </span>
              <span className="sr-only">{last}</span>
            </Link>
            <StartIssueButton issueKey={r.issueKey} connectionId={r.connectionId ?? undefined} controlId="dashboard.activity.start" className="absolute right-1.5 top-1.5" />
          </>
        );
      }}
    />
  );
}
