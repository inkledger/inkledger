import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { timerLog } from "@/lib/timerLog";

/** After any way in: a clean cache for this account, then where they were going. */
export function useSignedIn(from = "/") {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  return (user: Parameters<typeof utils.auth.me.setData>[1]) => {
    // A session that expired left the previous user's data in the cache
    // (and maybe a "Log time" request): never show it to this one.
    queryClient.clear();
    timerLog.clear();
    // Seed the session so the route guard sees it before any refetch.
    utils.auth.me.setData(undefined, user);
    void navigate(from, { replace: true });
  };
}
