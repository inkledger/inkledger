import { cn } from "@/lib/utils";
import { useRef } from "react";
import { Link } from "react-router";
import { useFitToHeight } from "@/lib/layout/fit";
import {
  CalendarDays,
  ChevronsRightLeft,
  Plus,
} from "lucide-react";
import { formatDate, parseDayKey } from "@contracts/time";
import { priorityLabel, priorityTone, type Tone } from "@/lib/jira";
import { projectOf } from "@/lib/projectColors";
import { Chip } from "@/components/app/Chip";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { t } from "@/i18n";
import { issuePath, issueId } from "@/lib/issues";
import { surface } from "@/components/app/surface";
import { CollapsedColumn, ColumnHeader } from "@/components/app/Columns";
import { flowControlProps } from "@/lib/workspace/instrumentation";

export type TaskIssue = {
  /** Its connection (a key may be on two) */
  connectionId?: number;
  key: string;
  summary: string;
  priority: string;
  dueDate: string | null;
  remoteUpdated: string | null;
  favorite: number;
};

export type TaskColumn = {
  title: string;
  tone: Tone;
  issues: TaskIssue[];
  total: number;
};

function cardDate(i: TaskIssue): { label: string; text: string } | null {
  const due = i.dueDate ? parseDayKey(i.dueDate) : null;
  if (due) return { label: t("views.dashboard.tasks.due"), text: formatDate(due, "short") };
  if (i.remoteUpdated)
    return { label: t("views.dashboard.tasks.updated"), text: formatDate(new Date(i.remoteUpdated), "short") };
  return null;
}

function TaskCard({
  issue,
}: {
  issue: TaskIssue;
}) {
  const date = cardDate(issue);
  return (
    <Link
      to={issuePath(issue)}
      {...surface("card")}
      {...flowControlProps("dashboard.tasks.issueOpen")}
      className="block rounded-xl border bg-card p-2.5 transition-[border-color] duration hover:border-foreground/15 hover:shadow-sm"
    >
      <p className="line-clamp-2 [overflow-wrap:anywhere] text-body-sm font-semibold leading-snug">
        {issue.summary}
      </p>
      <p className="mt-0.5 text-caption text-muted-foreground">{issue.key}</p>
      {date && (
        <p className="mt-1.5 flex items-center gap-1 text-caption text-muted-foreground">
          <CalendarDays className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">{date.label}:</span>
          {date.text}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <ProjectAvatar project={projectOf(issue.key)} size="xs" connectionId={issue.connectionId} />
        {issue.priority && (
          <Chip variant="dot" tone={priorityTone(issue.priority)}>
            {priorityLabel(issue.priority)}
          </Chip>
        )}
      </div>
    </Link>
  );
}

/**
 * Three-column snapshot of my issues (reference: "Project & Tasks"). A column
 * collapses sideways to a slim strip (title rotated, count), like the Board's.
 */
export function TasksBoard({
  columns,
  collapsed,
  onToggle,
}: {
  columns: TaskColumn[];
  collapsed: Set<string>;
  onToggle: (title: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row @l:group-data-[fill]/row:min-h-0 @l:group-data-[fill]/row:flex-1">
      {columns.map(col =>
        collapsed.has(col.title) ? (
          <CollapsedColumn
            key={col.title}
            title={col.title}
            count={col.total}
            tone={col.tone}
            label={t("views.dashboard.tasks.expandColumn", { title: col.title, total: col.total })}
            onOpen={() => onToggle(col.title)}
            control={flowControlProps("dashboard.tasks.collapse")}
          />
        ) : (
          <div key={col.title} className="min-w-0 flex-1 basis-0 @l:group-data-[fill]/row:flex @l:group-data-[fill]/row:min-h-0 @l:group-data-[fill]/row:flex-col">
            <ColumnHeader
              className="mb-2"
              title={col.title}
              count={col.total}
              tone={col.tone}
              actions={
                <>
                    <button
                      type="button"
                      onClick={() => onToggle(col.title)}
                      aria-expanded
                      {...flowControlProps("dashboard.tasks.collapse")}
                      aria-label={t("views.dashboard.tasks.collapseColumn", { title: col.title })}
                      title={t("views.dashboard.tasks.collapse", { title: col.title })}
                      className="inline-flex size-target items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronsRightLeft className="h-4 w-4" />
                    </button>
                    <Link
                      to="/board"
                      aria-label={t("views.dashboard.tasks.openBoard", { title: col.title })}
                      {...flowControlProps("dashboard.tasks.openBoard")}
                      className="inline-flex size-target items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Plus className="h-4 w-4" />
                    </Link>
                </>
              }
            />
            <ColumnCards issues={col.issues} total={col.total} title={col.title} />
          </div>
        )
      )}
    </div>
  );
}

/**
 * A column's cards, as many as its room holds (the bento row's height; on a phone its first ones), then
 * "Show all N" to the Board. Never a mask: the cards that do not fit are hidden, not cut in half while
 * still focusable (docs/design-system.md §7.1).
 */
/** Cards per column when the row is stacked (no height to fit): the rest a click away on the Board. */
const STACKED_FIRST = 2;

function ColumnCards({ issues, total, title }: { issues: TaskColumn["issues"]; total: number; title: string }) {
  const list = useRef<HTMLUListElement>(null);
  const more = useRef<HTMLAnchorElement>(null);
  useFitToHeight(list, more, total > issues.length);
  if (issues.length === 0)
    return (
      <p className="rounded-xl border border-dashed p-4 text-center text-body-sm text-muted-foreground" {...surface("glass")}>
        {t("views.dashboard.tasks.empty")}
      </p>
    );
  return (
    <div className="flex min-h-0 flex-col gap-2 @l:group-data-[fill]/row:flex-1">
      {/* In a row, as many as its height holds; stacked (below @l, no height to fit), the first two each. */}
      <ul ref={list} aria-label={title} className="stagger cast-room-x cast-room-y grid gap-2 [--room-b:0.25rem] [--room-x:0.5rem] max-@l:[&>li:nth-child(n+3)]:hidden">
        {issues.map(issue => (
          <li key={issueId(issue)}>
            <TaskCard issue={issue} />
          </li>
        ))}
      </ul>
      <Link ref={more} to="/board" {...flowControlProps("dashboard.tasks.more")} className={cn("justify-self-start text-body-sm font-medium text-primary-strong underline-offset-4 hover:underline", issues.length > STACKED_FIRST && "max-@l:!inline")}>
        {t("ui.collection.showAll", { count: total })} →
      </Link>
    </div>
  );
}
