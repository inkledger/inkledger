import { useState } from "react";
import { kindTitle } from "@/components/notifications/kindTitle";
import { errorText } from "@/lib/errorText";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { BellOff } from "lucide-react";
import { dayKey } from "@contracts/time";
import { notificationCenter } from "@/lib/flag";
import { useNotificationList } from "@/hooks/useNotificationList";
import { EmptyState, ErrorState } from "@/components/app/States";
import { SectionLabel } from "@/components/app/PageHeader";
import {
  NotificationItem,
  type NotificationRow,
} from "@/components/notifications/NotificationItem";
import { Button } from "@/components/ui/button";
import { TodoReminders } from "@/components/todo/TodoReminders";
import { useTodoReminders } from "@/hooks/useTodoReminders";
import { t } from "@/i18n";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

/** "Today" first, then everything older, newest first within each. */
function groups(items: NotificationRow[]) {
  const today = dayKey(new Date());
  const todays = items.filter(n => dayKey(n.createdAt) === today);
  const older = items.filter(n => dayKey(n.createdAt) !== today);
  return [
    { label: t("common.today"), items: todays },
    { label: t("settings.notifications.earlier"), items: older },
  ].filter(g => g.items.length > 0);
}

/**
 * Notification center: slides in from the right like macOS. Each notification can be read
 * here, opened, or archived without opening it.
 */
export function NotificationCenter() {
  const open = notificationCenter.useValue();
  const { query, items: all, dismiss, dismissMany, dismissAll } = useNotificationList();
  // Which kinds to show: all, or one (the kinds present, each with its count).
  const [kind, setKind] = useState<string>("all");
  const kinds: string[] = [...new Set(all.map(n => n.kind))];
  const shownKind = kind === "all" || kinds.includes(kind) ? kind : "all";
  const items = shownKind === "all" ? all : all.filter(n => n.kind === shownKind);
  const reminders = useTodoReminders().items.length;
  const close = () => notificationCenter.set(false);

  return (
    <Sheet open={open} onOpenChange={notificationCenter.set}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 bg-canvas p-0 sm:max-w-md"
      >
        <div className="flex items-center gap-3 border-b px-5 py-4 pr-12">
          <div className="min-w-0 flex-1">
            <SheetTitle className="font-display text-heading">
              {t("settings.notifications.centerTitle")}
            </SheetTitle>
            <SheetDescription className="text-caption text-muted-foreground">
              {items.length === 0
                ? t("settings.notifications.allRead")
                : t("settings.notifications.unread", { count: items.length })}
            </SheetDescription>
          </div>
          {items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={dismissAll}>
              {t("settings.tester.archiveAll")}
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          {query.isPending ? (
            <div className="grid gap-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : query.error ? (
            <ErrorState
              message={errorText(query.error)}
              onRetry={() => void query.refetch()}
            />
          ) : items.length === 0 && reminders === 0 ? (
            <EmptyState
              icon={BellOff}
              title={t("settings.notifications.emptyTitle")}
              message={t("settings.notifications.emptyMessage")}
            />
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
              {/* Today's TODOs first: what the user planned comes before what happened. */}
              <TodoReminders onOpen={close} />
              {kinds.length > 1 && (
                <SegmentedControl
                  label={t("settings.notifications.filterKinds")}
                  value={shownKind}
                  onChange={setKind}
                  options={[
                    { value: "all", label: `${t("settings.notifications.allKinds")} ${all.length}` },
                    ...kinds.map(k => ({ value: k, label: `${kindTitle(k)} ${all.filter(n => n.kind === k).length}` })),
                  ]}
                />
              )}
              {groups(items).map(g => (
                <TimeGroup key={g.label} label={g.label} items={g.items} bounded={g.label !== t("common.today")} onDismiss={dismiss} onDismissMany={dismissMany} onOpen={close} />
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Stacks shown in "Earlier" before "Show all": the newest ones, the rest a click away. */
const EARLIER_FIRST = 6;

/**
 * One time group (Today, Earlier) as stacks: a burst on the same issue is one stack, its newest on top,
 * "+N more" opens the rest in place and "Archive all N" takes them in one call. Earlier is bounded.
 */
function TimeGroup({ label, items, bounded, onDismiss, onDismissMany, onOpen }: { label: string; items: NotificationRow[]; bounded: boolean; onDismiss: (id: number) => void; onDismissMany: (ids: number[]) => void; onOpen: () => void }) {
  const [all, setAll] = useState(false);
  const stacks = new Map<string, NotificationRow[]>();
  for (const n of items) {
    const key = `${n.connectionId ?? ""}:${n.issueKey}`;
    stacks.set(key, [...(stacks.get(key) ?? []), n]);
  }
  const list = [...stacks.entries()];
  const shown = bounded && !all ? list.slice(0, EARLIER_FIRST) : list;
  return (
    <section aria-label={label}>
      <SectionLabel as="h3" className="mb-2 px-2">
        {label}
      </SectionLabel>
      <ul className="stagger grid grid-cols-[minmax(0,1fr)] gap-2">
        {shown.map(([key, stack]) => (
          <Stack key={key} items={stack} onDismiss={onDismiss} onDismissMany={onDismissMany} onOpen={onOpen} />
        ))}
      </ul>
      {bounded && list.length > EARLIER_FIRST && (
        <Button variant="ghost" size="sm" className="mt-2" aria-expanded={all} onClick={() => setAll(v => !v)}>
          {all ? t("ui.collection.showFewer") : t("ui.collection.showAll", { count: list.length })}
        </Button>
      )}
    </section>
  );
}

function Stack({ items, onDismiss, onDismissMany, onOpen }: { items: NotificationRow[]; onDismiss: (id: number) => void; onDismissMany: (ids: number[]) => void; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = items;
  if (rest.length === 0) return <NotificationItem n={first} onDismiss={onDismiss} onOpen={onOpen} className="shadow-xs" />;
  return (
    <li className="grid gap-1.5">
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
        <NotificationItem n={first} onDismiss={onDismiss} onOpen={onOpen} className="shadow-xs" />
        {open && rest.map(n => <NotificationItem key={n.id} n={n} onDismiss={onDismiss} onOpen={onOpen} className="ml-4" />)}
      </ul>
      <div className="flex flex-wrap items-center gap-2 pl-2">
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          {open ? t("settings.notifications.stackFewer", { issueKey: first.issueKey }) : t("settings.notifications.stackMore", { count: rest.length, issueKey: first.issueKey })}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onDismissMany(items.map(n => n.id))}>
          {t("settings.notifications.archiveStack", { count: items.length, issueKey: first.issueKey })}
        </Button>
      </div>
    </li>
  );
}
