/**
 * Kinds of persistent in-app notifications: what a sync sees change (the
 * first six), and what a tracker's own inbox says (mentioned, commented,
 * review asked, changed by someone).
 */
export const NOTIFICATION_KINDS = [
  "assigned",
  "unassigned",
  "priority",
  "due",
  "watch_added",
  "watch_removed",
  "mentioned",
  "commented",
  "review",
  "changed",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/** Priorities (Italian and English names) that raise a "priority" notification. */
export const CRITICAL_PRIORITIES: readonly string[] = [
  "Critica",
  "Urgente",
  "Bloccante",
  "Blocker",
  "Critical",
  "Highest",
];
