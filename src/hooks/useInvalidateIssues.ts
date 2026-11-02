import { trpc } from "@/lib/trpc";

/** Refresh the lists that show issues (Issues, the Board and the palette's catalogue, the favorites). */
export function useInvalidateIssues() {
  const utils = trpc.useUtils();
  return () =>
    Promise.all([
      utils.issues.list.invalidate(),
      utils.issues.all.invalidate(),
      utils.issues.favorites.invalidate(),
    ]);
}
