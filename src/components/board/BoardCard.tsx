import { useRef, useState } from "react";
import { ConnectionBadge } from "@/components/app/ConnectionBadge";
import { trpc } from "@/lib/trpc";
import { reachable, type BoardColumn } from "@/lib/boardTargets";
import { Link } from "react-router";
import { CalendarDays, Clock3, MoveRight, Pin, Star } from "lucide-react";
import { usePinIssue } from "@/hooks/usePinIssue";
import { formatDate, parseDayKey } from "@contracts/time";
import { priorityLabel, priorityTone } from "@/lib/jira";
import { relevanceText, issuePath } from "@/lib/issues";
import { projectOf } from "@/lib/projectColors";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { surface } from "@/components/app/surface";
import { Chip } from "@/components/app/Chip";
import { Button } from "@/components/ui/button";
import { t, dateFormat } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type BoardIssue = {
  /** Its connection (a key may be on two) */
  connectionId?: number;
  key: string;
  summary: string;
  status: string;
  priority: string | null;
  favorite: number;
  dueDate: string | null;
  /** Last change, activity or creation (epoch ms): the column order */
  relevantAt: number | null;
};

const full = () =>
  dateFormat({
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export function BoardCard({
  issue,
  columns,
  onMove,
  onDragStart,
  onDragEnd,
  onPrefetch,
}: {
  issue: BoardIssue & { connectionId: number; category: string };
  /** The board's columns: the menu offers those its tracker can take it to */
  columns: readonly (BoardColumn & { title: string })[];
  onMove: (columnId: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** About to be moved (hover, focus, a touch): its ways on, loaded ahead */
  onPrefetch: () => void;
}) {
  const due = issue.dueDate ? parseDayKey(issue.dueDate.slice(0, 10)) : null;
  const pin = usePinIssue();
  // The menu (keyboard, and a long press on touch) lists only where its tracker can take it.
  const [menu, setMenu] = useState(false);
  const ways = trpc.issues.transitions.useQuery({ key: issue.key, connectionId: issue.connectionId }, { enabled: menu, staleTime: 60_000 });
  const card = { connectionId: issue.connectionId, status: issue.status };
  const places = ways.data
    ? columns.filter(c => reachable(card, ways.data.map(w => ({ toStatus: w.toStatus, toCategory: w.toCategory, executable: w.executable })), c).length > 0)
    : null;
  const press = useRef<number | null>(null);
  const endPress = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
  };
  return (
    <div
      draggable
      {...surface("card")}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      onTouchStart={() => {
        onPrefetch();
        press.current = window.setTimeout(() => setMenu(true), 500);
      }}
      onTouchEnd={endPress}
      onTouchMove={endPress}
      onDragStart={e => {
        e.dataTransfer.setData("text/plain", issue.key);
        e.dataTransfer.setData("application/x-from-status", issue.status);
        e.dataTransfer.setData("application/x-connection", String(issue.connectionId));
        // move = change status (columns), copy = pin it (lavagna)
        e.dataTransfer.effectAllowed = "copyMove";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className="cursor-grab rounded-xl border bg-card p-2.5 text-body-sm shadow-sm transition-[box-shadow,border-color] duration hover:border-foreground/15 hover:shadow-sm active:cursor-grabbing"
    >
      <div className="flex items-start gap-1.5">
        <p className="line-clamp-2 min-w-0 flex-1 break-words text-body-sm font-semibold leading-snug">
          {issue.summary}
        </p>
        <DropdownMenu open={menu} onOpenChange={setMenu}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-1 -mt-1 size-7 shrink-0"
              aria-label={t("views.board.card.actions", { key: issue.key })}
              title={t("views.board.card.actionsHint")}
            >
              <MoveRight className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void pin(issue.key, issue.connectionId)}>
              <Pin className="h-4 w-4" /> {t("views.board.card.pin")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("views.board.card.moveTo")}</DropdownMenuLabel>
            {places === null ? (
              <DropdownMenuItem disabled>{ways.error ? ways.error.message : t("views.board.card.loadingMoves")}</DropdownMenuItem>
            ) : places.length === 0 ? (
              <DropdownMenuItem disabled>{t("views.board.card.noMoves")}</DropdownMenuItem>
            ) : (
              places.map(c => (
                <DropdownMenuItem key={c.id} onSelect={() => onMove(c.id)}>
                  {c.title}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 text-caption text-muted-foreground">
        <Link
          to={issuePath(issue)}
          className="hover:text-foreground hover:underline"
        >
          {issue.key}
        </Link>
        {issue.favorite === 1 && (
          <Star
            className="h-3.5 w-3.5 fill-warning text-warning"
            aria-label={t("views.board.card.favorite")}
          />
        )}
      </p>
      {(due || issue.relevantAt) && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-muted-foreground">
          {issue.relevantAt && (
            <span
              className="flex items-center gap-1"
              title={t("views.board.card.lastActivityAt", { date: full().format(issue.relevantAt) })}
            >
              <Clock3 className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">{t("views.board.card.lastActivity")}</span>
              {relevanceText(issue.relevantAt)}
            </span>
          )}
          {due && (
            <span className="flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">{t("views.board.card.due")}</span>
              {formatDate(due, "short")}
            </span>
          )}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <ProjectAvatar project={projectOf(issue.key)} size="xs" connectionId={issue.connectionId} />
          <ConnectionBadge connectionId={issue.connectionId} />
        </span>
        {issue.priority && (
          <Chip variant="dot" tone={priorityTone(issue.priority)}>
            {priorityLabel(issue.priority)}
          </Chip>
        )}
      </div>
    </div>
  );
}
