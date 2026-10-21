import { PanelSection } from "@/components/app/Panel";
import { useNotificationList } from "@/hooks/useNotificationList";
import { NotificationItem } from "@/components/notifications/NotificationItem";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/**
 * "For you": new work and changes that need attention (assigned, critical,
 * due soon, watchers…). Stays until dismissed by hand; hidden when empty.
 */
export function InboxCard() {
  const { items, dismiss, dismissAll } = useNotificationList();
  if (items.length === 0) return null;

  return (
    <PanelSection
      title={
        <span className="flex min-w-0 items-center gap-2">
          {t("views.dashboard.inbox.title")}
          <span data-lit="1" className="rounded-full bg-primary-soft px-2 text-caption font-semibold text-primary-strong tabular">
            {items.length}
          </span>
        </span>
      }
      className="border-b"
      actions={
        items.length > 1 && (
          <Button variant="ghost" size="sm" onClick={dismissAll}>
            {t("views.dashboard.inbox.archiveAll")}
          </Button>
        )
      }
    >
      <ul className="stagger grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
        {items.map(n => (
          <NotificationItem key={n.id} n={n} onDismiss={dismiss} />
        ))}
      </ul>
    </PanelSection>
  );
}
