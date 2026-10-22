import { errorText } from "@/lib/errorText";
import {
  ArrowRight,
  History,
  MessageSquare,
  Pencil,
  Sparkles,
} from "lucide-react";
import { surface } from "@/components/app/surface";
import { trpc } from "@/lib/trpc";
import { issueHistory, useIssueHistoryTarget } from "@/lib/issueHistory";
import { relevanceText } from "@/lib/issues";
import { ErrorState } from "@/components/app/States";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { t, dateFormat } from "@/i18n";

const full = () =>
  dateFormat({
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const ICON = {
  change: Pencil,
  comment: MessageSquare,
  created: Sparkles,
} as const;

/** Why an issue was updated, and everything before: changes, comments, creation. */
export function IssueHistoryDialog() {
  const target = useIssueHistoryTarget();
  return (
    <Dialog open={target !== null} onOpenChange={o => !o && issueHistory.close()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-xl">
        {target && <HistoryBody issueKey={target.key} connectionId={target.connectionId} />}
      </DialogContent>
    </Dialog>
  );
}

function HistoryBody({ issueKey, connectionId }: { issueKey: string; connectionId?: number }) {
  const history = trpc.issues.history.useQuery(
    { key: issueKey, connectionId },
    { retry: false, staleTime: 60_000 }
  );
  const events = history.data?.events ?? [];
  return (
    <>
      <DialogHeader className="border-b p-5">
        <DialogTitle className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t("views.issue.history.title", { key: issueKey })}
        </DialogTitle>
        <DialogDescription>
          {t("views.issue.history.description")}
        </DialogDescription>
        {history.data?.reason && (
          <p className="mt-2 rounded-lg bg-primary-soft px-3 py-2 text-body-sm text-primary-strong">
            <span className="font-semibold">{t("views.issue.history.lastUpdate")}</span>{" "}
            {history.data.reason}
            {events[0] && (
              <span className="text-primary-strong/80">
                {" "}
                · {relevanceText(events[0].at)}
              </span>
            )}
          </p>
        )}
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {history.isPending ? (
          <div className="grid gap-3">
            {[0, 1, 2].map(i => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : history.error ? (
          <ErrorState
            message={errorText(history.error)}
            onRetry={() => void history.refetch()}
          />
        ) : events.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">
            {t("views.issue.history.empty")}
          </p>
        ) : (
          <ol className="relative grid gap-4 border-l pl-5">
            {events.map((e, i) => {
              const Icon = ICON[e.kind];
              return (
                <li key={`${e.kind}-${e.at}-${i}`} className="relative">
                  <span
                    aria-hidden
                    {...surface("chip")}
                    className={cn(
                      "absolute -left-[1.85rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border bg-card text-muted-foreground",
                      i === 0 &&
                        "border-primary-strong/40 bg-primary-soft text-primary-strong"
                    )}
                  >
                    <Icon className="h-3 w-3" />
                  </span>
                  <p className="text-caption text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {e.author ?? t("views.issue.history.someone")}
                    </span>
                    {" · "}
                    <time
                      dateTime={new Date(e.at).toISOString()}
                      title={full().format(e.at)}
                    >
                      {relevanceText(e.at)}
                    </time>
                  </p>
                  {e.kind === "created" && (
                    <p className="mt-0.5 text-body-sm">{t("views.issue.history.created")}</p>
                  )}
                  {e.kind === "comment" && (
                    <p className="mt-0.5 line-clamp-3 text-body-sm text-muted-foreground">
                      “{e.excerpt}”
                    </p>
                  )}
                  {e.kind === "change" && (
                    <ul className="mt-0.5 grid gap-0.5 text-body-sm">
                      {e.items.map((it, j) => (
                        <li
                          key={j}
                          className="flex flex-wrap items-baseline gap-x-1.5"
                        >
                          <span className="font-medium">{it.field}</span>
                          {(it.from || it.to) && (
                            <>
                              {it.from && (
                                <span className="text-muted-foreground line-through decoration-muted-foreground/50">
                                  {it.from}
                                </span>
                              )}
                              <ArrowRight
                                className="h-3 w-3 self-center text-muted-foreground"
                                aria-label={t("views.issue.history.becomes")}
                              />
                              <span>{it.to ?? "—"}</span>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </>
  );
}
