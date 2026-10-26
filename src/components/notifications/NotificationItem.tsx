import { Link } from "react-router";
import { AtSign, CalendarClock, Eye, EyeOff, Flame, GitPullRequest, MessageSquare, Play, RefreshCw, UserMinus, UserPlus, X } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { parseDayKey } from "@contracts/time";
import { dateFormat, relativeFormat, t } from "@/i18n";
import { kindTitle } from "@/components/notifications/kindTitle";
import { useStartTimer } from "@/hooks/useStartTimer";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { Button } from "@/components/ui/button";
import { projectOf } from "@/lib/projectColors";
import { cn } from "@/lib/utils";
import { issuePath } from "@/lib/issues";
import { surface } from "@/components/app/surface";

export type NotificationRow =
  inferRouterOutputs<AppRouter>["notifications"]["list"][number];

const KIND_STYLE: Record<
  string,
  { icon: typeof UserPlus; tone: string; canStart: boolean }
> = {
  assigned: {
    icon: UserPlus,
    tone: "bg-primary-soft text-primary-strong",
    canStart: true,
  },
  priority: {
    icon: Flame,
    tone: "bg-danger-soft text-danger",
    canStart: true,
  },
  due: {
    icon: CalendarClock,
    tone: "bg-warning-soft text-warning",
    canStart: true,
  },
  unassigned: {
    icon: UserMinus,
    tone: "bg-muted text-muted-foreground",
    canStart: false,
  },
  watch_added: {
    icon: Eye,
    tone: "bg-primary-soft text-primary-strong",
    canStart: false,
  },
  watch_removed: {
    icon: EyeOff,
    tone: "bg-muted text-muted-foreground",
    canStart: false,
  },
  mentioned: {
    icon: AtSign,
    tone: "bg-primary-soft text-primary-strong",
    canStart: true,
  },
  commented: {
    icon: MessageSquare,
    tone: "bg-muted text-muted-foreground",
    canStart: false,
  },
  review: {
    icon: GitPullRequest,
    tone: "bg-warning-soft text-warning",
    canStart: true,
  },
  changed: {
    icon: RefreshCw,
    tone: "bg-muted text-muted-foreground",
    canStart: false,
  },
};

function ago(date: Date): string {
  const relative = relativeFormat();
  const min = Math.round((date.getTime() - Date.now()) / 60_000);
  if (Math.abs(min) < 1) return t("settings.notifications.now");
  if (Math.abs(min) < 60) return relative.format(min, "minute");
  const h = Math.round(min / 60);
  if (Math.abs(h) < 24) return relative.format(h, "hour");
  return relative.format(Math.round(h / 24), "day");
}

/** The reason line: what happened, and when. */
function reason(kind: string, detail: string, createdAt: Date): string {
  if (kind === "priority") return t("settings.notifications.nowPriority", { detail, ago: ago(createdAt) });
  if (kind === "due") {
    const d = parseDayKey(detail);
    return d
      ? t("settings.notifications.dueOn", {
          date: dateFormat({ weekday: "long", day: "numeric", month: "short" }).format(d),
        })
      : t("settings.notifications.dueSoon");
  }
  return `${kindTitle(kind)} · ${ago(createdAt)}`;
}

/**
 * One notification: opening the issue reads it, so it is archived and goes
 * away; start a timer or archive it (X) without opening it.
 */
export function NotificationItem({
  n,
  onDismiss,
  onOpen,
  className,
}: {
  n: NotificationRow;
  onDismiss: (id: number) => void;
  /** Called after following the link (e.g. close the panel). */
  onOpen?: () => void;
  className?: string;
}) {
  const start = useStartTimer({ announce: true });
  const style = KIND_STYLE[n.kind] ?? KIND_STYLE.assigned;
  const Icon = style.icon;
  return (
    <li
      {...surface("card")}
      className={cn(
        "group flex min-w-0 items-center gap-3 rounded-lg border bg-card p-3 transition-shadow hover:shadow-sm",
        className
      )}
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          style.tone
        )}
        aria-hidden
        {...surface("picture")}
      >
        <Icon className="h-4 w-4" />
      </span>
      <Link
        to={issuePath({ key: n.issueKey, connectionId: n.connectionId })}
        onClick={() => {
          onDismiss(n.id);
          onOpen?.();
        }}
        className="min-w-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ProjectAvatar project={projectOf(n.issueKey)} size="xs" connectionId={n.connectionId} />
          <span className="shrink-0 whitespace-nowrap font-semibold">
            {n.issueKey}
          </span>
          <span className="truncate text-caption text-muted-foreground">
            {reason(n.kind, n.detail, n.createdAt)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-body-sm">
          {n.summary ?? "—"}
        </span>
      </Link>
      <span className="flex shrink-0 items-center">
        {style.canStart && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("settings.notifications.startTimer", { issueKey: n.issueKey })}
            title={t("settings.notifications.startTimerShort")}
            onClick={() => start.mutate({ issueKey: n.issueKey, connectionId: n.connectionId })}
          >
            <Play className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("settings.notifications.archiveOne", { issueKey: n.issueKey })}
          title={t("settings.notifications.archive")}
          onClick={() => onDismiss(n.id)}
        >
          <X className="h-4 w-4" />
        </Button>
      </span>
    </li>
  );
}
