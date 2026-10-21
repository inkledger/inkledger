import { useState } from "react";
import { Link } from "react-router";
import { formatDurationLong } from "@contracts/time";
import { projectOf } from "@/lib/projectColors";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { EmptyState } from "@/components/app/States";
import { StatusBadge } from "@/components/StatusBadge";
import { t, dateFormat, currentLocale } from "@/i18n";
import {
  SortableHead,
  Table,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table";
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

type SortKey = "issue" | "last" | "status" | "seconds";

const when = () => dateFormat({ weekday: "short", day: "numeric", month: "short" });

function compare(a: ActivityRow, b: ActivityRow, key: SortKey): number {
  switch (key) {
    case "issue":
      return a.issueKey.localeCompare(b.issueKey, currentLocale(), { numeric: true });
    case "status":
      return (a.status ?? "").localeCompare(b.status ?? "", currentLocale());
    case "seconds":
      return b.seconds - a.seconds;
    default:
      return b.lastAt.getTime() - a.lastAt.getTime();
  }
}

function Head({
  k,
  sort,
  onSort,
  children,
  className,
}: {
  k: SortKey;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <SortableHead
      sort={sort === k ? "descending" : "none"}
      onSort={() => onSort(k)}
      className={className}
    >
      {children}
    </SortableHead>
  );
}

/** Issues worked on recently (reference: "Team Members Activity"). */
export function ActivityTable({ rows }: { rows: ActivityRow[] }) {
  const [sort, setSort] = useState<SortKey>("last");
  const sorted = [...rows].sort((a, b) => compare(a, b, sort));

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
    <>
      <Table containerClassName="hidden md:block" className="min-w-[640px]">
        <thead>
          <TableHeaderRow>
            <Head k="issue" sort={sort} onSort={setSort} className="pl-1">
              Issue
            </Head>
            <Head k="last" sort={sort} onSort={setSort}>
              {t("views.dashboard.activity.lastActivity")}
            </Head>
            <Head k="status" sort={sort} onSort={setSort}>
              {t("views.dashboard.activity.status")}
            </Head>
            <Head k="seconds" sort={sort} onSort={setSort} className="pr-1">
              {t("views.dashboard.activity.hours")}
            </Head>
          </TableHeaderRow>
        </thead>
        <tbody>
          {sorted.map(r => (
            <TableRow key={issueId(r)}>
              <td className="py-3 pl-1 pr-4">
                <Link
                  to={issuePath({ key: r.issueKey, connectionId: r.connectionId, remoteId: r.remoteId })}
                  className="flex items-center gap-3 hover:underline underline-offset-4"
                >
                  <ProjectAvatar project={projectOf(r.issueKey)} />
                  <span className="font-semibold">{r.issueKey}</span>
                </Link>
              </td>
              <td className="max-w-0 py-3 pr-4">
                <span className="block truncate">
                  {r.lastComment || r.summary || "—"}
                </span>
                <span className="block text-body-sm text-muted-foreground">
                  {when().format(r.lastAt)}
                </span>
              </td>
              <td className="py-3 pr-4">
                {r.status ? (
                  <StatusBadge
                    status={r.status}
                    category={r.category ?? ""}
                  />
                ) : (
                  "—"
                )}
              </td>
              <td className="py-3 pr-1 text-muted-foreground tabular">
                {formatDurationLong(r.seconds)}
              </td>
            </TableRow>
          ))}
        </tbody>
      </Table>
      <ul className="divide-y border-t md:hidden">
        {sorted.map(r => (
          <li key={issueId(r)} className="grid gap-1 py-3">
            <div className="flex items-center justify-between gap-3">
              <Link
                to={issuePath({ key: r.issueKey, connectionId: r.connectionId, remoteId: r.remoteId })}
                className="flex min-w-0 items-center gap-3 hover:underline underline-offset-4"
              >
                <ProjectAvatar project={projectOf(r.issueKey)} />
                <span className="font-semibold">{r.issueKey}</span>
              </Link>
              {r.status && (
                <StatusBadge
                  status={r.status}
                  category={r.category ?? ""}
                />
              )}
            </div>
            <span className="truncate text-body-sm">
              {r.lastComment || r.summary || "—"}
            </span>
            <span className="text-body-sm text-muted-foreground tabular">
              {when().format(r.lastAt)} · {formatDurationLong(r.seconds)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
