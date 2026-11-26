import { flowControlProps } from "@/lib/workspace/instrumentation";
import { makeTodo } from "@/lib/makeTodo";
import { ConnectionBadge } from "@/components/app/ConnectionBadge";
import { memo, useRef } from "react";
import { useStickyTable } from "@/hooks/useStickyTable";
import { Link } from "react-router";
import {
  History,
  ArrowDown,
  ArrowUp,
  Copy,
  GitCommitHorizontal,
  Eye,
  EyeOff,
  ExternalLink,
  GripVertical,
  MoreHorizontal,
  Star,
  ListChecks,
  Columns2,
} from "lucide-react";
import { CalendarDays, Clock, GitBranch, SquareCheck } from "@/components/app/icons";
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
import { activityText, issuePath, issueId, setIssueDragData } from "@/lib/issues";
import { useOpenBesideAction } from "@/hooks/useOpenBeside";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SortableHead,
  TableHead,
  TableHeaderRow,
} from "@/components/ui/table";
import { issueHistory } from "@/lib/issueHistory";
import { PinMenuItems } from "@/components/issue/PinMenu";
import { useProviderName, useTrackerOffers } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { ActionRow } from "@/components/app/ActionRow";
import { safeExternalUrl } from "@contracts/links";

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
      className="inline-flex items-center gap-1 rounded-sm underline decoration-dotted underline-offset-4 outline-none hover:text-foreground hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring"
    >
      <History className="h-3 w-3" aria-hidden />
      {children}
    </button>
  );
}

/** Several issues picked (x, the checkboxes) to open on the desk together. */
type PickProps = {
  picked: boolean;
  /** Something is picked: every checkbox shows, not only the hovered row's. */
  picking: boolean;
  /** The row by its identity (issueId) */
  onPick: (id: string) => void;
};

type RowProps = {
  issue: IssueItem;
  /** With the issue's connection: its key may be on two trackers. */
  onLog: (key: string, connectionId?: number) => void;
  pin?: PinProps;
  /** Keyboard selection (j / k), or a click on the row: the preview shows it. */
  selected?: boolean;
  /** A click on the row outside its controls selects it (the list's preview follows). */
  onSelect?: (id: string) => void;
  /** Picked for the desk (as plain values: a row redraws only when its own change). */
  picked?: boolean;
  picking?: boolean;
  onPick?: (id: string) => void;
};

const pickOf = ({ picked = false, picking = false, onPick }: Pick<RowProps, "picked" | "picking" | "onPick"> & Partial<RowProps>): PickProps | undefined =>
  onPick ? { picked, picking, onPick } : undefined;

/** The box that picks the row (or card) for the desk. */
function PickBox({ issue, pick, className }: { issue: IssueItem; pick: PickProps; className?: string }) {
  return (
    <Checkbox
      checked={pick.picked}
      onCheckedChange={() => pick.onPick(issueId(issue))}
      aria-label={t("pages.issues.pick", { key: issue.key })}
      title={t("pages.issues.pickTitle")}
      className={cn(!pick.picking && !pick.picked && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100", className)}
    />
  );
}

function dueText(issue: IssueItem): string | null {
  const due = issue.dueDate ? parseDayKey(issue.dueDate.slice(0, 10)) : null;
  return due ? formatDate(due, "short") : null;
}

function updatedText(issue: IssueItem): string | null {
  return issue.remoteUpdated ? formatDate(new Date(issue.remoteUpdated), "short") : null;
}

function Actions({ issue, onLog, pin: pinProps, pick }: Omit<RowProps, "picked" | "picking" | "onPick"> & { pick?: PickProps }) {
  const provider = useProviderName(issue.connectionId);
  const act = useIssueActions();
  const openBeside = useOpenBesideAction();
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
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => openBeside(issue)}>
            <Columns2 className="h-4 w-4" aria-hidden />
            {t("views.issues.row.openBeside")}
            <DropdownMenuShortcut>{t("ui.keys.shiftClick")}</DropdownMenuShortcut>
          </DropdownMenuItem>
          {pick && (
            <DropdownMenuItem onSelect={() => pick.onPick(issueId(issue))}>
              <SquareCheck className="h-4 w-4" aria-hidden />
              {pick.picked ? t("views.issues.row.unpick") : t("views.issues.row.pickForDesk")}
              <DropdownMenuShortcut>X</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
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
          <WatchItem issue={issue} act={act} />
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
            onSelect={() => act.copyBranch(issue)}
          >
            <GitBranch className="h-4 w-4" /> {t("views.issues.row.copyBranch")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act.copyCommit(issue)}>
            <GitCommitHorizontal className="h-4 w-4" /> {t("views.issues.row.copyCommit")}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={safeExternalUrl(issue.url)?.href} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" /> {t("views.issues.row.openJira", { provider })}
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** Everyone's time on its tracker, only where it is more than mine. */
/** Watch / unwatch, only on a tracker that can (as the issue page); mounted while the menu is open. */
function WatchItem({ issue, act }: { issue: IssueItem; act: ReturnType<typeof useIssueActions> }) {
  const offers = useTrackerOffers(issue.connectionId);
  if (!offers.watch) return null;
  return (
    <DropdownMenuItem onSelect={() => void act.setWatching(issue.key, issue.watching !== 1, issue.connectionId)}>
      <Eye className="h-4 w-4" />
      {issue.watching === 1 ? t("views.issues.row.unwatch") : t("views.issues.row.watch")}
    </DropdownMenuItem>
  );
}

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
      {...flowControlProps("issues.row.open")}
      // Dragged (to the Desk, its sidebar entry): the issue goes along, not only its link.
      onDragStart={e => setIssueDragData(e.dataTransfer, issue)}
      className="flex min-w-0 items-center gap-3 underline-offset-4 hover:underline"
    >
      <span className="relative shrink-0">
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
        className={cn("min-w-0 [overflow-wrap:anywhere] font-semibold", issue.unread && "text-primary-strong")}
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
  mirror,
  stick,
  optional,
  children,
  className,
}: {
  k: SortMode;
  /** Frozen column (useStickyTable). */
  stick?: string;
  /** Hidden while the list is too narrow for it (useStickyTable). */
  optional?: boolean;
  sort?: SortMode;
  /** Without it the column is a plain label (e.g. the manually ordered pins). */
  onSort?: (k: SortMode) => void;
  /** In the header strip: the keyboard skips it. */
  mirror: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  if (!onSort) return <TableHead data-stick={stick} data-opt={optional || undefined} className={className}><span data-col className="inline-block w-max">{children}</span></TableHead>;
  return (
    <SortableHead
      sort={
        sort === k ? (ASCENDING.has(k) ? "ascending" : "descending") : "none"
      }
      onSort={() => onSort(k)}
      tabIndex={mirror ? -1 : undefined}
      data-stick={stick}
      data-opt={optional || undefined}
      className={className}
    >
      {children}
    </SortableHead>
  );
}

/** Sorts whose order is ascending (the others show newest / most urgent first). */
const ASCENDING = new Set<SortMode>(["key", "due"]);

/**
 * The header's cells, in the table and in its strip. Frozen at the start: the pick box, the star, the key
 * and the title; at the end: the timer (live controls) and the row's actions. The middle scrolls sideways.
 */
function HeadCells({ sort, onSort, mirror = false }: { sort?: SortMode; onSort?: (k: SortMode) => void; mirror?: boolean }) {
  return (
    <>
      <TableHead data-stick="1" className="pl-2 pr-0">
        <span className="sr-only">{t("pages.issues.pickCol")}</span>
      </TableHead>
      <TableHead data-stick="2" className="pl-1">
        <span className="sr-only">{t("views.issues.row.favouriteCol")}</span>
      </TableHead>
      <Head k="key" sort={sort} onSort={onSort} mirror={mirror} className="pr-3" stick="3">
        {t("views.issues.row.key")}
      </Head>
      <TableHead data-stick="4" data-stick-edge="start" className="pr-3"><span data-col className="inline-block w-max">{t("views.issues.row.title")}</span></TableHead>
      <TableHead className="pl-3 pr-3"><span data-col className="inline-block w-max">{t("views.issues.row.status")}</span></TableHead>
      <Head k="priority" sort={sort} onSort={onSort} mirror={mirror} className="pr-3">
        {t("views.issues.row.priority")}
      </Head>
      <Head k="updated" sort={sort} onSort={onSort} mirror={mirror} optional className="pr-3">
        {t("views.issues.row.updated")}
      </Head>
      <Head k="due" sort={sort} onSort={onSort} mirror={mirror} optional className="pr-3">
        {t("views.issues.row.due")}
      </Head>
      <TableHead className="whitespace-nowrap pr-3 text-right"><span data-col className="inline-block w-max">{t("views.issues.row.logged")}</span></TableHead>
      <TableHead data-stick="r2" data-stick-edge="end" className="pl-3">
        {/* Its label in a box of its own: the frozen cell's ground is what covers the middle's labels. */}
        <span data-col className="inline-block w-max">{t("views.issues.row.timer")}</span>
      </TableHead>
      <TableHead data-stick="r1" className="pr-1">
        <span className="sr-only">{t("views.issues.row.actions")}</span>
      </TableHead>
    </>
  );
}

/**
 * The columns' widths, shared by every table of the page (the favourites and the rest line up): each the
 * widest of its cells' contents in all of them (`--col-N`, written by useStickyTable); the title takes the rest.
 */
function Columns() {
  return (
    <colgroup>
      <col className="[width:var(--col-0)]" />
      <col className="[width:var(--col-1)]" />
      <col className="[width:var(--col-2)]" />
      <col />
      <col className="[width:var(--col-4)]" />
      <col className="[width:var(--col-5)]" />
      <col data-opt className="[width:var(--col-6)]" />
      <col data-opt className="[width:var(--col-7)]" />
      <col className="[width:var(--col-8)]" />
      <col className="[width:var(--col-9)]" />
      <col className="[width:var(--col-10)]" />
    </colgroup>
  );
}

/**
 * Desktop table (same look as the dashboard activity table). Too narrow for every column, Updated and
 * Due leave; still too narrow, its first and last columns stay put while the middle scrolls sideways.
 * Its header stays under the page's bars (useStickyTable).
 */
export function IssueTable({
  sort,
  onSort,
  children,
}: {
  sort?: SortMode;
  onSort?: (k: SortMode) => void;
  children: React.ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLTableRowElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  useStickyTable({ wrap, scroller, head, strip });
  return (
    <div ref={wrap} className="sticky-table hidden md:block">
      {/* The header again, shown only while the table's own has scrolled under the bars: for the eye and
          the pointer (the keyboard and screen readers have the real one). */}
      <div aria-hidden className="sticky-table-bar">
        <div ref={strip} className="cast-room-x overflow-hidden border-b bg-card pt-2">
          <table className="table-fixed text-left text-body-sm [min-width:var(--cols-min,720px)]">
            <Columns />
            <thead>
              <TableHeaderRow>
                <HeadCells sort={sort} onSort={onSort} mirror />
              </TableHeaderRow>
            </thead>
          </table>
        </div>
      </div>
      <div ref={scroller} data-slot="table-container" data-overflow-ok className="cast-room-x cast-room-y overflow-x-auto">
        {/* As wide as the table: the sentinels at its two ends say what is scrolled under the frozen columns. */}
        <div className="relative inline-block min-w-full align-top">
          <span aria-hidden data-edge="start" className="pointer-events-none absolute top-0 h-px w-px [left:calc(var(--room-l,0px)*-1)]" />
          <table data-slot="table" className="w-full table-fixed text-left text-body-sm [min-width:var(--cols-min,720px)]">
            <Columns />
            <thead>
              <TableHeaderRow ref={head}>
                <HeadCells sort={sort} onSort={onSort} />
              </TableHeaderRow>
            </thead>
            <tbody className="stagger">{children}</tbody>
          </table>
          <span aria-hidden data-edge="end" className="pointer-events-none absolute top-0 h-px w-px [right:calc(var(--room-r,0px)*-1)]" />
        </div>
      </div>
    </div>
  );
}

export const IssueRow = memo(function IssueRow({
  issue,
  onLog,
  pin,
  selected = false,
  onSelect,
  ...picks
}: RowProps) {
  const due = dueText(issue);
  const updated = updatedText(issue);
  const activity = activityText(issue);
  const pick = pickOf(picks);
  return (
    <tr
      data-issue-id={issueId(issue)}
      onClick={onSelect && (event => {
        if (event.target instanceof Element && event.target.closest("a, button, input, label, [role=checkbox], [role=menuitem]")) return;
        onSelect(issueId(issue));
      })}
      aria-selected={selected || undefined}
      data-picked={pick?.picked || undefined}
      data-drop-over={pin?.over || undefined}
      className={cn(
        "group border-t transition-[opacity,background-color]",
        pick?.picked && "bg-primary-soft/40",
        selected && "bg-accent/70 shadow-[inset_2px_0_0_hsl(var(--primary))]",
        pin?.dragging && "opacity-40",
        pin?.over && "bg-primary-soft/60"
      )}
      draggable={!!pin}
      onDragStart={
        pin &&
        (e => {
          // Moved among the pins, or copied to the Desk.
          e.dataTransfer.effectAllowed = "copyMove";
          e.dataTransfer.setData("text/plain", issue.key);
          setIssueDragData(e.dataTransfer, issue);
          pin.onDragStart(issueId(issue));
        })
      }
      onDragEnter={pin && (() => pin.onDragEnter(issueId(issue)))}
      onDragOver={pin && (e => e.preventDefault())}
      onDrop={pin && (e => e.preventDefault())}
      onDragEnd={pin?.onDragEnd}
    >
      <td data-stick="1" className="py-3 pl-2 pr-0">
        <div data-col className="w-max">{pick && <PickBox issue={issue} pick={pick} className="flex" />}</div>
      </td>
      <td data-stick="2" className="py-3 pl-1">
        <span data-col className="relative flex w-max items-center">
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
      <td data-stick="3" className="whitespace-nowrap py-3 pr-3">
        <div data-col className="w-max">
          <KeyLink issue={issue} />
        </div>
      </td>
      <td data-stick="4" data-stick-edge="start" className="py-2.5 pr-3">
        <span
          className="line-clamp-2 [overflow-wrap:anywhere]"
          title={issue.summary}
        >
          {issue.summary}
        </span>
        {(activity || !issue.isMine) && (
          // One line, cut short: the row keeps its height whatever the activity says.
          <span className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-caption text-muted-foreground [&>*]:truncate">
            {!issue.isMine && <Chip tone="warning">{t("views.issues.row.unassigned")}</Chip>}
            {activity && <HistoryLink issueKey={issue.key} connectionId={issue.connectionId}>{activity}</HistoryLink>}
          </span>
        )}
      </td>
      <td className="py-3 pl-3 pr-3">
        <div data-col className="w-max">
          <StatusBadge status={issue.status} category={issue.category} />
        </div>
      </td>
      <td className="py-3 pr-3">
        <div data-col className="w-max">
          {issue.priority ? (
            <Chip variant="dot" tone={priorityTone(issue.priority)}>
              {priorityLabel(issue.priority)}
            </Chip>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </td>
      <td data-opt className="whitespace-nowrap py-3 pr-3 text-muted-foreground">
        <div data-col className="w-max">
          {updated ? (
            <HistoryLink issueKey={issue.key} connectionId={issue.connectionId}>{updated}</HistoryLink>
          ) : (
            "—"
          )}
        </div>
      </td>
      <td data-opt className="whitespace-nowrap py-3 pr-3 text-muted-foreground">
        <div data-col className="w-max">{due ?? "—"}</div>
      </td>
      <td className="whitespace-nowrap py-3 pr-3 text-right text-muted-foreground tabular">
        {/* Nothing logged: empty, as on the phone's card (a column of zeros says nothing). */}
        <div data-col className="ml-auto w-max">
          {issue.mySpentSeconds > 0 && <span className="text-foreground">{formatDuration(issue.mySpentSeconds)}</span>}
          <TeamTotal issue={issue} className="block text-caption" />
        </div>
      </td>
      <td data-stick="r2" data-stick-edge="end" className="py-3 pl-3">
        <div data-col className="w-max">
          <TimerControls issueKey={issue.key} connectionId={issue.connectionId} />
        </div>
      </td>
      <td data-stick="r1" className="py-3 pr-1">
        {/* Always shown, quiet at rest; full strength on the row's hover or focus. */}
        <div data-col className="ml-auto flex w-max items-center justify-end text-muted-foreground group-focus-within:text-foreground group-hover:text-foreground">
          <Actions issue={issue} onLog={onLog} pin={pin} pick={pick} />
        </div>
      </td>
    </tr>
  );
});

export const IssueCard = memo(function IssueCard({
  issue,
  onLog,
  pin,
  selected = false,
  ...picks
}: RowProps) {
  const due = dueText(issue);
  const activity = activityText(issue);
  const pick = pickOf(picks);
  return (
    // The keyboard's selection shows on a phone too (j / k work there as well).
    <li data-issue-id={issueId(issue)} data-selected={selected || undefined} data-picked={pick?.picked || undefined} className={cn("grid gap-2 py-3", selected && "-mx-2 rounded-md bg-accent/70 px-2 shadow-[inset_2px_0_0_hsl(var(--primary))]")}>
      <ActionRow
        leading={pick?.picking ? (
          // Picking (from a card's menu): each card's box, at a finger's size.
          <span className="flex size-touch items-center justify-center">
            <PickBox issue={issue} pick={pick} />
          </span>
        ) : issue.hidden === 1 ? (
          <EyeOff
            className="mx-2 h-4 w-4 text-muted-foreground"
            aria-label={t("views.issues.row.hiddenLabel")}
          />
        ) : (
          <FavoriteStar issueKey={issue.key} connectionId={issue.connectionId} favorite={issue.favorite === 1} />
        )}
        actions={<Actions issue={issue} onLog={onLog} pin={pin} pick={pick} />}
      >
        <span className="flex min-w-0 items-center gap-1">
          <KeyLink issue={issue} />
          {!issue.isMine && <Chip tone="warning">{t("views.issues.row.unassigned")}</Chip>}
        </span>
      </ActionRow>
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
