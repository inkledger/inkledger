import { trpc } from "@/lib/trpc";

/** Open issues of mine with news since my last visit (sidebar counter): counted on the server. */
export function useUnreadCount(): number {
  return trpc.issues.unreadCount.useQuery(undefined, { staleTime: 60_000 }).data ?? 0;
}
