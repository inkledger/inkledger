import { surface } from "@/components/app/surface";
import { useState } from "react";
import { Link } from "react-router";
import { formatDuration } from "@contracts/time";
import {
  rowLabel,
  splitLabel,
  type GroupBy,
  type ReportRow,
} from "@/lib/reportLabel";
import { projectOf } from "@/lib/projectColors";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { Meter } from "@/components/app/Meter";
import {
  SortableHead,
  Table,
  TableHead,
  TableHeaderRow,
  TableRow,
} from "@/components/ui/table";
import { t, currentLocale } from "@/i18n";
import { issuePath } from "@/lib/issues";

type SortKey = "label" | "seconds" | "entries";
type Sort = { key: SortKey; dir: 1 | -1 } | null;

const heading = (groupBy: GroupBy) =>
  ({
    day: t("views.reports.rows.day"),
    issue: t("views.reports.rows.issue"),
    project: t("views.reports.rows.project"),
    client: t("views.reports.rows.client"),
  })[groupBy];

function Head({
  k,
  sort,
  onSort,
  children,
  className,
}: {
  k: SortKey;
  sort: Sort;
  onSort: (k: SortKey) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <SortableHead
      sort={
        sort?.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"
      }
      onSort={() => onSort(k)}
      className={className}
    >
      {children}
    </SortableHead>
  );
}

function RowLabel({ groupBy, row }: { groupBy: GroupBy; row: ReportRow }) {
  if (groupBy === "day") {
    return <span className="font-medium">{rowLabel(groupBy, row)}</span>;
  }
  const { head, tail } = splitLabel(row.label);
  const project = groupBy === "issue" ? projectOf(row.key) : groupBy === "client" ? row.label : row.key;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <ProjectAvatar project={project} />
      <div className="min-w-0">
        {groupBy === "issue" ? (
          <Link
            to={issuePath({ key: row.key, connectionId: row.connectionId, remoteId: row.remoteId })}
            className="font-semibold [overflow-wrap:anywhere] underline-offset-4 hover:underline"
          >
            {head}
          </Link>
        ) : (
          <span className="font-semibold">{head}</span>
        )}
        {tail && (
          <span className="block truncate text-body-sm text-muted-foreground">
            {tail}
          </span>
        )}
      </div>
    </div>
  );
}

/** Report detail table (same look as the dashboard activity table). */
export function ReportRows({
  rows,
  groupBy,
}: {
  rows: ReportRow[];
  groupBy: GroupBy;
}) {
  const [sort, setSort] = useState<Sort>(null);
  const toggle = (key: SortKey) =>
    setSort(s =>
      s?.key === key
        ? { key, dir: s.dir === 1 ? -1 : 1 }
        : { key, dir: key === "label" ? 1 : -1 }
    );
  const sorted = sort
    ? [...rows].sort((a, b) => {
        const d =
          sort.key === "label"
            ? groupBy === "day"
              ? a.key.localeCompare(b.key)
              : a.label.localeCompare(b.label, currentLocale(), { numeric: true })
            : a[sort.key] - b[sort.key];
        return d * sort.dir;
      })
    : rows;
  const max = Math.max(1, ...rows.map(r => r.seconds));

  return (
    <>
      <Table containerClassName="hidden md:block" className="min-w-[560px]">
        <thead>
          <TableHeaderRow>
            <Head k="label" sort={sort} onSort={toggle} className="pl-1">
              {heading(groupBy)}
            </Head>
            <TableHead>{t("views.reports.rows.distribution")}</TableHead>
            <Head k="seconds" sort={sort} onSort={toggle}>
              {t("views.reports.rows.hours")}
            </Head>
            <Head k="entries" sort={sort} onSort={toggle} className="pr-1">
              {t("views.reports.rows.entries")}
            </Head>
          </TableHeaderRow>
        </thead>
        <tbody>
          {sorted.map(r => (
            <TableRow key={r.id ?? r.key}>
              <td className="max-w-0 py-3 pl-1 pr-4 sm:w-[34%]">
                <RowLabel groupBy={groupBy} row={r} />
              </td>
              <td className="py-3 pr-4">
                <Meter
                  value={r.seconds}
                  max={max}
                  tone="bg-chart-focus"
                  size="lg"
                  lit
                />
              </td>
              <td className="whitespace-nowrap py-3 pr-4 font-medium tabular">
                {formatDuration(r.seconds)}
              </td>
              <td className="whitespace-nowrap py-3 pr-1 text-muted-foreground tabular">
                {r.entries}
              </td>
            </TableRow>
          ))}
        </tbody>
      </Table>
      {/* The table's column sorts, on a phone: one native select (its own picker, big enough to tap). */}
      <label className="flex items-center justify-end gap-2 pb-2 text-body-sm text-muted-foreground md:hidden">
        {t("views.reports.rows.sortBy")}
        <select
          {...surface("control")}
          className="min-h-touch rounded-md border bg-background px-2 text-body-sm text-foreground"
          value={sort ? `${sort.key}:${sort.dir}` : ""}
          onChange={e => {
            const [key, dir] = e.target.value.split(":");
            setSort(key ? { key: key as SortKey, dir: dir === "1" ? 1 : -1 } : null);
          }}
        >
          <option value="">{t("views.reports.rows.sortDefault")}</option>
          <option value="seconds:-1">{t("views.reports.rows.sortHoursDesc")}</option>
          <option value="seconds:1">{t("views.reports.rows.sortHoursAsc")}</option>
          <option value="label:1">{t("views.reports.rows.sortName")}</option>
          <option value="entries:-1">{t("views.reports.rows.sortEntries")}</option>
        </select>
      </label>
      <ul className="divide-y border-t md:hidden">
        {sorted.map(r => (
          <li key={r.id ?? r.key} className="grid gap-2 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <RowLabel groupBy={groupBy} row={r} />
              </div>
              <span className="shrink-0 text-body-sm tabular">
                <span className="font-medium">{formatDuration(r.seconds)}</span>
                <span className="text-muted-foreground"> · {t("views.reports.rows.entryCount", { count: r.entries })}</span>
              </span>
            </div>
            <Meter
              value={r.seconds}
              max={max}
              tone="bg-chart-focus"
              size="lg"
              lit
            />
          </li>
        ))}
      </ul>
    </>
  );
}
