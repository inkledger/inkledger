import { ArrowRightLeft, AtSign, Eye, EyeOff, Flame, GitPullRequest, MessageSquare, RefreshCw, UserMinus, UserPlus } from "lucide-react";
import { CalendarClock } from "@/components/app/icons";
import { parseDayKey } from "@contracts/time";
import { dateFormat, relativeFormat, t } from "@/i18n";
import { kindTitle } from "@/components/notifications/kindTitle";

/** Each kind's icon and tone, and whether a timer on its issue is offered. */
export const KIND_STYLE: Record<
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
  status: {
    icon: ArrowRightLeft,
    tone: "bg-muted text-muted-foreground",
    canStart: false,
  },
};

/** "5 min ago", "2 hours ago": how long since. */
export function ago(date: Date): string {
  const relative = relativeFormat();
  const min = Math.round((date.getTime() - Date.now()) / 60_000);
  if (Math.abs(min) < 1) return t("settings.notifications.now");
  if (Math.abs(min) < 60) return relative.format(min, "minute");
  const h = Math.round(min / 60);
  if (Math.abs(h) < 24) return relative.format(h, "hour");
  return relative.format(Math.round(h / 24), "day");
}

/** The reason line: what happened, and when. */
export function reason(kind: string, detail: string, createdAt: Date): string {
  if (kind === "priority") return t("settings.notifications.nowPriority", { detail, ago: ago(createdAt) });
  if (kind === "status" && detail) return t("settings.notifications.statusFromTo", { detail, ago: ago(createdAt) });
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
