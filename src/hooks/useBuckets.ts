import { trpc } from "@/lib/trpc";

/** Board and palette: this device's bucket (the server knows it from the device id). */
export const BUCKET_SCOPE = { scope: "bucket" } as const;

/** The user's buckets, the one this device has on, and switching it (everything follows). */
export function useBuckets() {
  const utils = trpc.useUtils();
  const list = trpc.buckets.list.useQuery(undefined, { staleTime: 60_000 });
  const setActive = trpc.buckets.setActive.useMutation({ onSuccess: () => void utils.invalidate() });
  const buckets = list.data?.buckets ?? [];
  const active = buckets.find(b => b.id === list.data?.active) ?? null;
  return { buckets, active, choose: (id: number | null) => setActive.mutate({ id }), switching: setActive.isPending };
}
