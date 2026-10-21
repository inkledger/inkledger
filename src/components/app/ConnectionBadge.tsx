import { useConnections } from "@/hooks/useConnections";
import { Chip } from "@/components/app/Chip";

/**
 * Which tracker an issue is on (its connection's name), only when the user
 * has more than one: with one it would say nothing (T3).
 */
export function ConnectionBadge({ connectionId, className }: { connectionId?: number | null; className?: string }) {
  const trackers = (useConnections().data ?? []).filter(c => c.role === "tracker");
  const own = trackers.find(c => c.id === connectionId);
  if (trackers.length < 2 || !own) return null;
  return <Chip className={className}>{own.label || own.name}</Chip>;
}
