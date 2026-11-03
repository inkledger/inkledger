import { ToggleChip } from "@/components/app/ToggleChip";
import { useState } from "react";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { formatDate, formatDuration, parseDayKey } from "@contracts/time";
import { errorText } from "@/lib/errorText";
import type { IssueLogRow } from "@/lib/issueWorklogs";
import { cn } from "@/lib/utils";
import { PanelSection } from "@/components/app/Panel";
import { Chip } from "@/components/app/Chip";
import { EmptyState, ErrorState } from "@/components/app/States";
import { WorklogSinkState } from "@/components/issue/WorklogSinkState";
import {
  LogTimeDialog,
  type EditableWorklog,
} from "@/components/LogTimeDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { dateTime } from "@/components/issue/issueFormat";
import type { Issue, IssueData } from "@/components/issue/useIssueData";
import { t } from "@/i18n";

/** Worklogs shown before "Show all": the latest ones. */
const WORKLOGS_FIRST = 8;

/** The issue's worklogs, mine beside the team's, with edit, delete and a sync from its tracker. */
export function IssueWorklogs({
  issue: i,
  issueKey: key,
  data: { logs, team, provider, timeHere, syncLogs, del },
  logRows,
}: {
  issue: Issue;
  /** The key it was opened by (the worklogs are read and written on it). */
  issueKey: string;
  data: IssueData;
  logRows: IssueLogRow<NonNullable<IssueData["logs"]["data"]>[number]>[];
}) {
  const [editing, setEditing] = useState<EditableWorklog | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Mine stand out only beside someone else's.
  const withOthers = logRows.some(r => r.kind === "other");
  // Who logged how much: a chip each, which also narrows the list to that person (none pressed: all).
  const [person, setPerson] = useState<string | null>(null);
  const [allRows, setAllRows] = useState(false);
  const personOf = (row: (typeof logRows)[number]) => (row.kind === "mine" ? "" : row.entry.authorName || t("pages.issueDetail.someoneElse"));
  const secondsOf = (row: (typeof logRows)[number]) => (row.kind === "mine" ? row.log.timeSpentSeconds : row.entry.seconds);
  const people = [...logRows.reduce((map, row) => map.set(personOf(row), (map.get(personOf(row)) ?? 0) + secondsOf(row)), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const narrowed = person === null ? logRows : logRows.filter(row => personOf(row) === person);
  const visibleRows = allRows ? narrowed : narrowed.slice(0, WORKLOGS_FIRST);
  return (
    <>
      <PanelSection
        title={t("pages.issueDetail.worklogs")}
        className="border-b"
        actions={
          !timeHere && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                syncLogs.mutate({
                  issueKey: key,
                  connectionId: i.connectionId,
                })
              }
              disabled={syncLogs.isPending}
            >
              <RefreshCw
                className={cn(
                  "h-4 w-4",
                  syncLogs.isPending && "motion-safe:animate-spin"
                )}
              />
              {t("pages.issueDetail.sync")}
            </Button>
          )
        }
      >
        {logs.isPending ? (
          <div className="grid gap-2">
            {Array.from({ length: 3 }).map((_, n) => (
              <Skeleton key={n} className="h-14" />
            ))}
          </div>
        ) : logs.error ? (
          <ErrorState
            message={errorText(logs.error)}
            onRetry={() => logs.refetch()}
          />
        ) : logRows.length === 0 ? (
          <EmptyState
            art="inbox"
            title={t("pages.issueDetail.noWorklogs")}
            message={t("pages.issueDetail.noWorklogsHint")}
          />
        ) : (
          <>
          {team.error && (
            <p className="mb-2 text-caption text-muted-foreground">
              {t("pages.issueDetail.othersUnavailable")}
            </p>
          )}
          {withOthers && people.length > 1 && (
            <div role="group" aria-label={t("pages.issueDetail.byPerson")} className="mb-2 flex flex-wrap gap-1.5">
              {people.map(([who, seconds]) => (
                <ToggleChip key={who || "me"} size="sm" pressed={person === who} onClick={() => setPerson(p => (p === who ? null : who))}>
                  {who || t("views.issue.comments.you")}
                  <span className="tabular opacity-70">{formatDuration(seconds)}</span>
                </ToggleChip>
              ))}
            </div>
          )}
          <ul className="divide-y" data-testid="issue-worklogs">
            {visibleRows.map(row => {
              if (row.kind === "other") {
                const e = row.entry;
                return (
                  <li
                    key={`other-${e.remoteId}`}
                    data-mine="false"
                    className="flex items-start gap-3 border-l-2 border-transparent py-3 pl-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tabular text-muted-foreground">
                          {formatDuration(e.seconds)}
                        </span>
                        <span className="text-body-sm text-muted-foreground">
                          {e.authorName || t("pages.issueDetail.someoneElse")}
                        </span>
                      </div>
                      <div className="text-caption text-muted-foreground">
                        {e.start !== null
                          ? dateTime().format(new Date(e.start))
                          : e.day
                            ? formatDate(parseDayKey(e.day) ?? new Date(0), "long")
                            : "—"}
                      </div>
                      {e.comment && (
                        <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-body-sm text-muted-foreground">
                          {e.comment}
                        </p>
                      )}
                    </div>
                  </li>
                );
              }
              const w = row.log;
              const pending = w.remoteId.startsWith("pending-");
              const started = new Date(w.started);
              return (
                <li
                  key={w.id}
                  data-mine="true"
                  className={cn(
                    "flex items-start gap-3 py-3",
                    withOthers && "border-l-2 border-primary bg-primary-soft pl-3"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tabular font-medium">
                        {formatDuration(w.timeSpentSeconds)}
                      </span>
                      <span className="text-body-sm font-medium">
                        {t("pages.issueDetail.you")}
                      </span>
                      {pending && (
                        <Chip tone="warning">
                          {t("pages.issueDetail.queued")}
                        </Chip>
                      )}
                      {!pending && <WorklogSinkState worklogId={w.id} sink={w.sink} provider={provider} />}
                    </div>
                    <div className="text-caption text-muted-foreground">
                      {dateTime().format(started)}
                    </div>
                    {w.comment && (
                      <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-body-sm">
                        {w.comment}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("pages.issueDetail.editWorklog")}
                    disabled={!!w.sink.locked}
                    title={w.sink.locked ? t("views.worklogSink.locked", { provider }) : undefined}
                    onClick={() =>
                      setEditing({
                        id: w.id,
                        connectionId: i.connectionId,
                        remoteId: w.remoteId,
                        timeSpentSeconds: w.timeSpentSeconds,
                        started: new Date(w.started),
                        comment: w.comment,
                      })
                    }
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-danger"
                    aria-label={t("pages.issueDetail.deleteWorklog")}
                    disabled={!!w.sink.locked}
                    onClick={() => setDeleting(w.remoteId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
          {/* The latest ones, then all of them on request (a long-running issue has hundreds). */}
          {narrowed.length > WORKLOGS_FIRST && (
            <Button variant="ghost" size="sm" className="mt-2" aria-expanded={allRows} onClick={() => setAllRows(v => !v)}>
              {allRows ? t("ui.collection.showFewer") : t("ui.collection.showAll", { count: narrowed.length })}
            </Button>
          )}
          </>
        )}
      </PanelSection>

      {editing && (
        <LogTimeDialog
          issueKey={key}
          connectionId={i.connectionId}
          worklog={editing}
          open
          onOpenChange={o => {
            if (!o) setEditing(null);
          }}
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={o => {
          if (!o) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("pages.issueDetail.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.issueDetail.deleteText", { provider })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("pages.issueDetail.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                if (deleting)
                  del.mutate({ issueKey: key, remoteId: deleting, connectionId: i.connectionId });
              }}
            >
              {t("pages.issueDetail.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
