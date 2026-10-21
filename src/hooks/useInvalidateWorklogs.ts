import { trpc } from "@/lib/trpc";

/** Refresh everything that shows logged time. */
export function useInvalidateWorklogs() {
  const utils = trpc.useUtils();
  return () => {
    void utils.worklogs.invalidate();
    void utils.stats.invalidate();
    void utils.reports.invalidate();
    void utils.outbox.invalidate();
    void utils.timers.invalidate();
    // The issue's logged total ("Logged") moves with it.
    void utils.issues.get.invalidate();
    void utils.issues.list.invalidate();
  };
}
