import { Link } from "react-router";
import {
  CalendarDays,
  ChevronsLeftRight,
  ChevronsRightLeft,
  Plus,
} from "lucide-react";
import { formatDate, parseDayKey } from "@contracts/time";
import { priorityLabel, priorityTone, type Tone } from "@/lib/jira";
import { projectOf } from "@/lib/projectColors";
import { Chip, Dot } from "@/components/app/Chip";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { t } from "@/i18n";
import { issuePath, issueId } from "@/lib/issues";
import { surface } from "@/components/app/surface";

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
      className="block rounded-xl border bg-card p-2.5 transition-[box-shadow,border-color] duration hover:border-foreground/15 hover:shadow-sm"
    >
      <p className="line-clamp-2 text-body-sm font-semibold leading-snug">
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
    <div className="flex flex-col gap-3 sm:flex-row">
      {columns.map(col =>
        collapsed.has(col.title) ? (
          <button
            key={col.title}
            type="button"
            onClick={() => onToggle(col.title)}
            aria-expanded={false}
            aria-label={t("views.dashboard.tasks.expandColumn", { title: col.title, total: col.total })}
            title={t("views.dashboard.tasks.expand", { title: col.title })}
            {...surface("control")}
            className="flex shrink-0 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-body-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:w-11 sm:flex-col sm:px-0 sm:py-3"
          >
            <ChevronsLeftRight
              className="h-4 w-4 text-muted-foreground"
              aria-hidden
            />
            <Dot tone={col.tone} />
            <span className="text-muted-foreground tabular">{col.total}</span>
            <span className="whitespace-nowrap sm:[writing-mode:vertical-rl]">
              {col.title}
            </span>
          </button>
        ) : (
          <div key={col.title} className="min-w-0 flex-1 basis-0">
            <div {...surface("card")} className="mb-2 flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-body-sm font-medium">
              <Dot tone={col.tone} />
              <span className="truncate">{col.title}</span>
              <span className="text-muted-foreground tabular">{col.total}</span>
              <span className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => onToggle(col.title)}
                  aria-expanded
                  aria-label={t("views.dashboard.tasks.collapseColumn", { title: col.title })}
                  title={t("views.dashboard.tasks.collapse", { title: col.title })}
                  className="rounded p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronsRightLeft className="h-4 w-4" />
                </button>
                <Link
                  to="/board"
                  aria-label={t("views.dashboard.tasks.openBoard", { title: col.title })}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Plus className="h-4 w-4" />
                </Link>
              </span>
            </div>
            <div className="stagger cast-room-x cast-room-y relative max-h-[25rem] space-y-2 overflow-hidden [--room-b:0.25rem] [--room-x:0.5rem] [mask-image:linear-gradient(to_bottom,black_80%,transparent)]">
              {col.issues.length === 0 ? (
                <p className="rounded-xl border border-dashed p-4 text-center text-body-sm text-muted-foreground" {...surface("glass")}>
                  {t("views.dashboard.tasks.empty")}
                </p>
              ) : (
                col.issues.map(issue => (
                  <TaskCard key={issueId(issue)} issue={issue} />
                ))
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
}
