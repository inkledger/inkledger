import { trpc } from "@/lib/trpc";
import { visibleIssues } from "@/lib/issues";
import { isClosed } from "@contracts/categories";

/** Open issues of mine with news since my last visit (sidebar counter). */
export function useUnreadCount(): number {
  const all = trpc.issues.all.useQuery(undefined, { staleTime: 60_000 });
  return visibleIssues(all.data ?? []).filter(
    i => i.unread && i.isMine && !isClosed(i.category)
  ).length;
}
