import { trpc } from "@/lib/trpc";

/** What the issue's tracker lets the app change (nothing while unknown). */
export function useManageable({ issueKey, connectionId }: { issueKey: string; connectionId?: number | null }) {
  const q = trpc.issues.manageable.useQuery({ key: issueKey, connectionId: connectionId ?? undefined }, { staleTime: 5 * 60_000, retry: false });
  return q.data ?? { assign: false, labels: false, create: false, edit: false };
}
