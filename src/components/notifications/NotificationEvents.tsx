import { useLayoutEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Chip } from "@/components/app/Chip";
import { RichText } from "@/components/app/RichText";
import { surface } from "@/components/app/surface";
import { kindTitle } from "@/components/notifications/kindTitle";
import { KIND_STYLE, ago, reason } from "@/components/notifications/notificationKinds";
import { assignment, commentFor, mentionExcerpt, mentionFor, statusChange, type FieldChange } from "@/components/notifications/notificationDetail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { InboxRow } from "@/hooks/useInbox";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

const COMMENT_KINDS = new Set(["commented", "mentioned", "review"]);
const HISTORY_KINDS = new Set(["status", "assigned", "unassigned"]);
const NO_IMAGES = new Map<string, string>();

/**
 * What happened on one issue, each notification with its substance: the comment itself (clamped, "Show
 * all"), the sentence that mentions you, "from → to" of a status or an assignee with who did it. Read from
 * the issue's own comments and history (read-only calls, cached with the issue's sections); what they
 * can't say falls back to the notification's own line.
 */
export function NotificationEvents({ items, issueKey, connectionId }: { items: readonly InboxRow[]; issueKey: string; connectionId: number }) {
  const where = { key: issueKey, connectionId };
  const comments = trpc.issues.comments.useQuery(where, { enabled: items.some(n => COMMENT_KINDS.has(n.kind)), retry: false, staleTime: 60_000 });
  const history = trpc.issues.history.useQuery(where, { enabled: items.some(n => HISTORY_KINDS.has(n.kind)), retry: false, staleTime: 60_000 });
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] divide-y">
      {items.map(n => (
        <Event
          key={n.id}
          n={n}
          connectionId={connectionId}
          comments={{ list: comments.data ?? [], loading: comments.isLoading }}
          history={{ events: history.data?.events ?? [], loading: history.isLoading }}
        />
      ))}
    </ul>
  );
}

type Outputs = inferRouterOutputs<AppRouter>["issues"];
type Comments = { list: Outputs["comments"]; loading: boolean };
type History = { events: Outputs["history"]["events"]; loading: boolean };

function Event({ n, connectionId, comments, history }: { n: InboxRow; connectionId: number; comments: Comments; history: History }) {
  const style = KIND_STYLE[n.kind] ?? KIND_STYLE.assigned;
  const Icon = style.icon;
  const unread = n.readAt === null;
  const list = comments.list;
  const events = history.events;
  const comment = n.kind === "commented" ? commentFor(n, list) : COMMENT_KINDS.has(n.kind) ? mentionFor(n, list) : null;
  const change = n.kind === "status" ? statusChange(n, events) : n.kind === "assigned" || n.kind === "unassigned" ? assignment(n, events) : null;
  const author = comment?.author ?? change?.author ?? null;
  const loading = (COMMENT_KINDS.has(n.kind) && comments.loading) || (HISTORY_KINDS.has(n.kind) && history.loading);
  return (
    <li className="grid min-w-0 gap-1.5 py-2.5" data-unread={unread || undefined}>
      <div className="flex min-w-0 items-center gap-2">
        {/* The dot's slot is always there: read and unread rows start at the same edge. */}
        <span className="flex w-1.5 shrink-0 justify-center" aria-hidden>
          {unread && <span className="h-1.5 w-1.5 rounded-full bg-primary-strong" {...surface("chip")} />}
        </span>
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", style.tone)} aria-hidden {...surface("picture")}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-body-sm", unread ? "font-medium text-foreground" : "text-muted-foreground")}>
          {kindTitle(n.kind)}
          {author && <span className="font-normal text-muted-foreground"> · {author}</span>}
          {unread && <span className="sr-only">, {t("pages.notifications.unreadDot")}</span>}
        </span>
        <span className="shrink-0 text-caption text-muted-foreground">{ago(n.createdAt)}</span>
      </div>
      <div className={cn("min-w-0 pl-10 text-body-sm", !unread && "text-muted-foreground")}>
        {loading ? (
          <Skeleton className="h-4 w-2/3" />
        ) : n.kind === "commented" && comment ? (
          <Clamp>
            <RichText doc={comment.doc} images={NO_IMAGES} connectionId={connectionId} collapseAfter={Number.MAX_SAFE_INTEGER} />
          </Clamp>
        ) : COMMENT_KINDS.has(n.kind) && comment ? (
          <blockquote className="border-l-2 pl-3 [overflow-wrap:anywhere]">{mentionExcerpt(comment.body)}</blockquote>
        ) : change && (change.from !== null || change.to !== null) ? (
          <FromTo change={change} />
        ) : (
          <Fallback n={n} />
        )}
      </div>
    </li>
  );
}

/** What the notification itself says, when the issue can't tell more (a tracker out of reach, an inbox thread). */
function Fallback({ n }: { n: InboxRow }) {
  const line = n.kind === "priority" || n.kind === "due" ? reason(n.kind, n.detail, n.createdAt).split(" · ")[0] : n.detail;
  if (!line) return null;
  return <p className="[overflow-wrap:anywhere]">{line}</p>;
}

/** "Da fare → In corso" as two chips. */
function FromTo({ change }: { change: FieldChange }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Chip wrap>{change.from ?? "—"}</Chip>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t("pages.notifications.to")} />
      <Chip wrap tone="info">{change.to ?? "—"}</Chip>
    </p>
  );
}

/** About six lines, then "Show all" in place. */
function Clamp({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [open, children]);
  return (
    <div className="grid justify-items-start gap-1">
      <div ref={box} className={cn("min-w-0 max-w-full [overflow-wrap:anywhere]", !open && "line-clamp-6")} data-overflow-ok={!open || undefined}>
        {children}
      </div>
      {(long || open) && (
        <Button variant="link" size="sm" className="h-auto px-0" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          {open ? t("pages.notifications.showLess") : t("pages.notifications.showWhole")}
        </Button>
      )}
    </div>
  );
}
