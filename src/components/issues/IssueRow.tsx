import { makeTodo } from "@/lib/makeTodo";
import { ConnectionBadge } from "@/components/app/ConnectionBadge";
import { memo } from "react";
import { Link } from "react-router";
import {
  History,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Clock,
  Copy,
  GitBranch,
  Eye,
  EyeOff,
  ExternalLink,
  GripVertical,
  MoreHorizontal,
  Star,
  ListChecks,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { formatDate, formatDuration, parseDayKey } from "@contracts/time";
import { priorityLabel, priorityTone } from "@/lib/jira";
import { projectOf } from "@/lib/projectColors";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/app/Chip";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { StatusBadge } from "@/components/StatusBadge";
import { TimerControls } from "@/components/TimerControls";
import { FavoriteStar } from "@/components/FavoriteStar";
import type { SortMode } from "@/components/issues/IssueFilters";
import { useIssueActions } from "@/hooks/useIssueActions";
import { activityText, issuePath, issueId } from "@/lib/issues";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SortableHead,
  Table,
  TableHead,
  TableHeaderRow,
} from "@/components/ui/table";
import { issueHistory } from "@/lib/issueHistory";
import { PinMenuItems } from "@/components/issue/PinMenu";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";

export type IssueItem =
  inferRouterOutputs<AppRouter>["issues"]["list"]["issues"][number];

/** Pinned favorites: manual order by drag & drop or the menu. */
export type PinProps = {
  first: boolean;
  last: boolean;
  /** The row by its identity (issueId) */
  onMove: (key: string, dir: -1 | 1) => void;
  dragging: boolean;
  over: boolean;
  onDragStart: (key: string) => void;
  onDragEnter: (key: string) => void;
  onDragEnd: () => void;
};

/** A date or "why it moved" text that opens the issue's history. */
function HistoryLink({
  issueKey,
  connectionId,
  children,
}: {
  issueKey: string;
  connectionId?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={t("views.issues.row.history")}
      onClick={e => {
        e.stopPropagation();
        e.preventDefault();
        issueHistory.open(issueKey, connectionId);
      }}
      className="inline-flex items-center gap-1 rounded-sm underline decoration-dotted underline-offset-4 outline-none hover:text-foreground hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <History className="h-3 w-3" aria-hidden />
      {children}
    </button>
  );
}

type RowProps = {
  issue: IssueItem;
  /** With the issue's connection: its key may be on two trackers. */
  onLog: (key: string, connectionId?: number) => void;
  pin?: PinProps;
  /** Keyboard selection (j / k). */
  selected?: boolean;
};

function dueText(issue: IssueItem): string | null {
  const due = issue.dueDate ? parseDayKey(issue.dueDate.slice(0, 10)) : null;
  return due ? formatDate(due, "short") : null;
}

function updatedText(issue: IssueItem): string | null {
  return issue.remoteUpdated ? formatDate(new Date(issue.remoteUpdated), "short") : null;
}

function Actions({ issue, onLog, pin: pinProps }: RowProps) {
  const provider = useProviderName(issue.connectionId);
  const act = useIssueActions();
  const favorite = issue.favorite === 1;
  const hidden = issue.hidden === 1;
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("views.issues.row.logTimeOn", { key: issue.key })}
        title={t("views.issues.row.logTime")}
        onClick={() => onLog(issue.key, issue.connectionId)}
      >
        <Clock className="h-4 w-4" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("views.issues.row.moreActionsOn", { key: issue.key })}
            title={t("views.issues.row.moreActions")}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {!hidden && (
            <DropdownMenuItem onSelect={() => act.toggleFavorite(issue.key, issue.connectionId)}>
              <Star className="h-4 w-4" />
              {favorite ? t("views.issues.row.unfavorite") : t("views.issues.row.favorite")}
            </DropdownMenuItem>
          )}
          <PinMenuItems issueKey={issue.key} connectionId={issue.connectionId} label={t("views.issues.row.pin")} />
          <DropdownMenuItem onSelect={() => makeTodo.ask({ issueKey: issue.key, connectionId: issue.connectionId ?? undefined })}>
            <ListChecks className="h-4 w-4" aria-hidden />
            {t("views.todos.menuAdd")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void act.setWatching(issue.key, issue.watching !== 1, issue.connectionId)}
          >
            <Eye className="h-4 w-4" />
            {issue.watching === 1 ? t("views.issues.row.unwatch") : t("views.issues.row.watch")}
          </DropdownMenuItem>
          {pinProps && (
            <>
              <DropdownMenuItem
                disabled={pinProps.first}
                onSelect={() => pinProps.onMove(issueId(issue), -1)}
              >
                <ArrowUp className="h-4 w-4" /> {t("views.issues.row.moveUp")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={pinProps.last}
                onSelect={() => pinProps.onMove(issueId(issue), 1)}
              >
                <ArrowDown className="h-4 w-4" /> {t("views.issues.row.moveDown")}
              </DropdownMenuItem>
            </>
          )}
          {hidden ? (
            <DropdownMenuItem onSelect={() => act.restore(issue.key, issue.connectionId)}>
              <Eye className="h-4 w-4" /> {t("views.issues.row.restore")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => act.hide(issue.key, issue.connectionId)}>
              <EyeOff className="h-4 w-4" /> {t("views.issues.row.hide")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => act.copyKey(issue.key)}>
            <Copy className="h-4 w-4" /> {t("views.issues.row.copyKey")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => act.copyBranch(issue.key, issue.summary)}
          >
            <GitBranch className="h-4 w-4" /> {t("views.issues.row.copyBranch")}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={issue.url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" /> {t("views.issues.row.openJira", { provider })}
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** Everyone's time on its tracker, only where it is more than mine. */
function TeamTotal({ issue, className }: { issue: IssueItem; className?: string }) {
  const team = issue.timeSpentSeconds ?? 0;
  if (team <= issue.mySpentSeconds) return null;
  const label = t("views.issues.row.teamTotal", { time: formatDuration(team) });
  return (
    <span className={cn("text-muted-foreground", className)} title={label}>
      {label}
    </span>
  );
}

function KeyLink({ issue }: { issue: IssueItem }) {
  return (
    <Link
      to={issuePath(issue)}
      viewTransition
      className="flex items-center gap-3 underline-offset-4 hover:underline"
    >
      <span className="relative">
        <ProjectAvatar
          project={projectOf(issue.key)}
          connectionId={issue.connectionId}
          className="h-8 w-8"
          transitionName={`issue-${issue.key}`}
        />
        {issue.unread && (
          <span
            title={t("views.issues.row.newSinceVisit")}
            {...surface("chip")}
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-primary-strong ring-2 ring-card"
          >
            <span className="sr-only">{t("views.issues.row.news")}</span>
          </span>
        )}
      </span>
      <span
        className={cn("font-semibold", issue.unread && "text-primary-strong")}
      >
        {issue.key}
      </span>
      <ConnectionBadge connectionId={issue.connectionId} />
    </Link>
  );
}

function Head({
  k,
  sort,
  onSort,
  children,
  className,
}: {
  k: SortMode;
  sort?: SortMode;
  /** Without it the column is a plain label (e.g. the manually ordered pins). */
  onSort?: (k: SortMode) => void;
  children: React.ReactNode;
  className?: string;
}) {
  if (!onSort) return <TableHead className={className}>{children}</TableHead>;
  return (
    <SortableHead
      sort={
        sort === k ? (ASCENDING.has(k) ? "ascending" : "descending") : "none"
      }
      onSort={() => onSort(k)}
      className={className}
    >
      {children}
    </SortableHead>
  );
}

/** Sorts whose order is ascending (the others show newest / most urgent first). */
const ASCENDING = new Set<SortMode>(["key", "due"]);

/** Desktop table (same look as the dashboard activity table). */
export function IssueTable({
  sort,
  onSort,
  children,
}: {
  sort?: SortMode;
  onSort?: (k: SortMode) => void;
  children: React.ReactNode;
}) {
  return (
    <Table containerClassName="hidden md:block" className="min-w-[720px]">
      <thead>
        <TableHeaderRow>
          <TableHead className="w-9 pl-1">
            <span className="sr-only">{t("views.issues.row.favouriteCol")}</span>
          </TableHead>
          <Head k="key" sort={sort} onSort={onSort}>
            {t("views.issues.row.key")}
          </Head>
          <TableHead>{t("views.issues.row.title")}</TableHead>
          <TableHead>{t("views.issues.row.status")}</TableHead>
          <Head k="priority" sort={sort} onSort={onSort}>
            {t("views.issues.row.priority")}
          </Head>
          <Head
            k="updated"
            sort={sort}
            onSort={onSort}
            className="hidden 2xl:table-cell"
          >
            {t("views.issues.row.updated")}
          </Head>
          <Head
            k="due"
            sort={sort}
            onSort={onSort}
            className="hidden 2xl:table-cell"
          >
            {t("views.issues.row.due")}
          </Head>
          <TableHead className="whitespace-nowrap text-right">{t("views.issues.row.logged")}</TableHead>
          <TableHead className="pl-3">{t("views.issues.row.timer")}</TableHead>
          <TableHead className="pr-1">
            <span className="sr-only">{t("views.issues.row.actions")}</span>
          </TableHead>
        </TableHeaderRow>
      </thead>
      <tbody className="stagger">{children}</tbody>
    </Table>
  );
}

export const IssueRow = memo(function IssueRow({
  issue,
  onLog,
  pin,
  selected = false,
}: RowProps) {
  const due = dueText(issue);
  const updated = updatedText(issue);
  const activity = activityText(issue);
  return (
    <tr
      data-issue-key={issue.key}
      aria-selected={selected || undefined}
      className={cn(
        "group border-t transition-[opacity,background-color]",
        selected && "bg-accent/70 shadow-[inset_2px_0_0_hsl(var(--primary))]",
        pin?.dragging && "opacity-40",
        pin?.over && "bg-primary-soft/60"
      )}
      draggable={!!pin}
      onDragStart={
        pin &&
        (e => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", issue.key);
          pin.onDragStart(issueId(issue));
        })
      }
      onDragEnter={pin && (() => pin.onDragEnter(issueId(issue)))}
      onDragOver={pin && (e => e.preventDefault())}
      onDrop={pin && (e => e.preventDefault())}
      onDragEnd={pin?.onDragEnd}
    >
      <td className="w-9 py-3 pl-1">
        <span className="relative flex items-center">
          {pin && (
            <GripVertical
              aria-hidden
              className="absolute -left-3.5 h-3.5 w-3.5 cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            />
          )}
          {issue.hidden === 1 ? (
            <EyeOff
              className="mx-2 h-4 w-4 text-muted-foreground"
              aria-label={t("views.issues.row.hiddenLabel")}
            />
          ) : (
            <FavoriteStar
              issueKey={issue.key}
              connectionId={issue.connectionId}
              favorite={issue.favorite === 1}
            />
          )}
        </span>
      </td>
      <td className="whitespace-nowrap py-3 pr-3">
        <KeyLink issue={issue} />
      </td>
      <td className="w-full min-w-64 max-w-0 py-2.5 pr-3">
        <span
          className="line-clamp-2 [overflow-wrap:anywhere]"
          title={issue.summary}
        >
          {issue.summary}
        </span>
        {(activity || !issue.isMine) && (
          <span className="mt-1 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            {!issue.isMine && <Chip tone="warning">{t("views.issues.row.unassigned")}</Chip>}
            {activity && <HistoryLink issueKey={issue.key} connectionId={issue.connectionId}>{activity}</HistoryLink>}
          </span>
        )}
      </td>
      <td className="py-3 pr-3">
        <StatusBadge status={issue.status} category={issue.category} />
      </td>
      <td className="py-3 pr-3">
        {issue.priority ? (
          <Chip variant="dot" tone={priorityTone(issue.priority)}>
            {priorityLabel(issue.priority)}
          </Chip>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="hidden whitespace-nowrap py-3 pr-3 text-muted-foreground 2xl:table-cell">
        {updated ? (
          <HistoryLink issueKey={issue.key} connectionId={issue.connectionId}>{updated}</HistoryLink>
        ) : (
          "—"
        )}
      </td>
      <td className="hidden whitespace-nowrap py-3 pr-3 text-muted-foreground 2xl:table-cell">
        {due ?? "—"}
      </td>
      <td className="whitespace-nowrap py-3 text-right text-muted-foreground tabular">
        <span className="text-foreground">{formatDuration(issue.mySpentSeconds)}</span>
        <TeamTotal issue={issue} className="block text-caption" />
      </td>
      <td className="w-40 py-3 pl-3">
        <TimerControls issueKey={issue.key} connectionId={issue.connectionId} />
      </td>
      <td className="py-3 pr-1">
        <div className="flex items-center justify-end opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Actions issue={issue} onLog={onLog} pin={pin} />
        </div>
      </td>
    </tr>
  );
});

export const IssueCard = memo(function IssueCard({
  issue,
  onLog,
  pin,
}: RowProps) {
  const due = dueText(issue);
  const activity = activityText(issue);
  return (
    <li className="grid gap-2 py-3">
      <div className="flex items-center gap-1">
        {issue.hidden === 1 ? (
          <EyeOff
            className="mx-2 h-4 w-4 text-muted-foreground"
            aria-label={t("views.issues.row.hiddenLabel")}
          />
        ) : (
          <FavoriteStar issueKey={issue.key} connectionId={issue.connectionId} favorite={issue.favorite === 1} />
        )}
        <KeyLink issue={issue} />
        {!issue.isMine && <Chip tone="warning">{t("views.issues.row.unassigned")}</Chip>}
        <div className="ml-auto flex items-center">
          <Actions issue={issue} onLog={onLog} pin={pin} />
        </div>
      </div>
      <p className="[overflow-wrap:anywhere] text-body-sm">{issue.summary}</p>
      {activity && (
        <p className="-mt-1 text-caption text-muted-foreground">
          <HistoryLink issueKey={issue.key} connectionId={issue.connectionId}>{activity}</HistoryLink>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={issue.status} category={issue.category} />
        {issue.priority && (
          <Chip variant="dot" tone={priorityTone(issue.priority)}>
            {priorityLabel(issue.priority)}
          </Chip>
        )}
        {due && (
          <span className="inline-flex items-center gap-1 text-caption text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">{t("views.issues.row.dueSr")}</span>
            {due}
          </span>
        )}
        <span className="ml-auto text-caption text-muted-foreground tabular">
          {issue.mySpentSeconds ? formatDuration(issue.mySpentSeconds) : ""}
          <TeamTotal issue={issue} className="ml-1" />
        </span>
      </div>
      <TimerControls issueKey={issue.key} connectionId={issue.connectionId} />
    </li>
  );
});
