import { errorText } from "@/lib/errorText";
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
  const { query, items, dismiss, dismissAll } = useNotificationList();
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
              {groups(items).map(g => (
                <section key={g.label} aria-label={g.label}>
                  <SectionLabel as="h3" className="mb-2 px-2">
                    {g.label}
                  </SectionLabel>
                  <ul className="stagger grid grid-cols-[minmax(0,1fr)] gap-2">
                    {g.items.map(n => (
                      <NotificationItem
                        key={n.id}
                        n={n}
                        onDismiss={dismiss}
                        onOpen={close}
                        className="shadow-xs"
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
