import { trpc } from "@/lib/trpc";

/**
 * Current session user. Only a `null` answer from auth.me means signed out:
 * a network error or 5xx is "unreachable", and the guards keep the route
 * (with a reconnecting state) instead of bouncing to /login.
 */
export function useAuth() {
  const me = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
    // While the server is unreachable, keep trying in the background.
    refetchInterval: query => (query.state.status === "error" ? 5_000 : false),
  });
  return {
    user: me.data ?? null,
    isLoading: me.isPending,
    isAuthenticated: !!me.data,
    /** Server confirmed there is no session (or a call came back UNAUTHORIZED). */
    isSignedOut: me.data === null,
    /** auth.me failed and we never got an answer: unknown, not signed out. */
    isUnreachable: me.isError && me.data === undefined,
    isRetrying: me.isFetching,
    retry: () => void me.refetch(),
  };
}
