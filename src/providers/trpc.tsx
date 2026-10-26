import type { AppRouter } from "../../api/router";
import { httpBatchLink, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { eventsOf } from "@/modules/appEvents";
import {
  HydrationBoundary,
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  type DehydratedState,
} from "@tanstack/react-query";
import superjson from "superjson";
import { useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { getLocale } from "@/i18n";
import { deviceId } from "@/lib/device";
import { pageQueriesOf } from "@/lib/pageQueries";
import { logFault } from "@/lib/errorText";
import { APP_BUILD_CHANGED, APP_BUILD_HEADER, APP_BUILD_META } from "@contracts/appBuild";

/** The build this page's code comes from; none in development. */
const pageBuild = typeof document === "undefined" ? null : document.querySelector<HTMLMetaElement>(`meta[name="${APP_BUILD_META}"]`)?.content ?? null;

/**
 * The server runs a newer build: reload once to get it (the service worker
 * updated first, so the shell isn't served from its cache). A second
 * refusal of the same build doesn't loop: the page stays.
 */
function reloadForNewBuild(error: unknown): boolean {
  if (!(error instanceof TRPCClientError) || error.message !== APP_BUILD_CHANGED) return false;
  const key = "ikl-build-reload";
  try {
    if (sessionStorage.getItem(key) === pageBuild) return true;
    sessionStorage.setItem(key, pageBuild ?? "");
  } catch {
    // storage unavailable: reload anyway (at worst once more)
  }
  void (async () => {
    try {
      await (await navigator.serviceWorker?.getRegistration())?.update();
    } catch {
      // no service worker: a plain reload
    }
    location.reload();
  })();
  return true;
}

function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    (error.data as { code?: string } | undefined)?.code === "UNAUTHORIZED"
  );
}

/** Session expiry and tracker failures update only this browser's/request's cache. */
function onAuthError(queryClient: QueryClient, error: unknown, queryKey?: readonly unknown[]) {
  if (reloadForNewBuild(error)) return;
  if (error instanceof TRPCClientError && (error.data as { code?: string } | undefined)?.code === "PRECONDITION_FAILED") {
    void queryClient.invalidateQueries({ queryKey: [["connections", "list"]] });
    return;
  }
  if (!isUnauthorized(error)) return;
  const isMeQuery = Array.isArray(queryKey?.[0]) && (queryKey[0] as unknown[]).join(".") === "auth.me";
  if (isMeQuery) return;
  queryClient.setQueriesData({ queryKey: [["auth", "me"]] }, null);
}

/** Each mutation the server answered tells the module host what happened (WP-17). */
const appEventsLink: TRPCLink<AppRouter> = () => ({ op, next }) =>
  observable(observer =>
    next(op).subscribe({
      next(result) {
        if (op.type === "mutation") {
          try {
            eventsOf(op.path, op.input, result.result.type === "data" ? result.result.data : undefined);
          } catch (e) {
            console.warn(`[app events] ${String(e)}`);
          }
        }
        observer.next(result);
      },
      error: err => observer.error(err),
      complete: () => observer.complete(),
    })
  );

// Shared with the SSR renderer; this file's Fast Refresh boundary is the provider below.
// eslint-disable-next-line react-refresh/only-export-components
export function createTRPCContext(existing?: QueryClient) {
  const queryClient: QueryClient = existing ?? new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        logFault(error);
        onAuthError(queryClient, error, query.queryKey);
      },
    }),
    mutationCache: new MutationCache({
      onError: error => onAuthError(queryClient, error),
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => !isUnauthorized(error) && count < 1,
      },
    },
  });
  if (typeof window !== "undefined") pageQueriesOf(queryClient);
  const trpcClient = trpc.createClient({
    links: [
      appEventsLink,
      httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        headers: () => ({ "x-locale": getLocale(), "x-device-id": deviceId(), ...(pageBuild ? { [APP_BUILD_HEADER]: pageBuild } : {}) }),
        fetch(input, init) {
          return globalThis.fetch(input, { ...(init ?? {}), credentials: "include" });
        },
      }),
    ],
  });
  return { queryClient, trpcClient };
}

export type TRPCContext = ReturnType<typeof createTRPCContext>;

const browserContext = typeof document === "undefined" ? undefined : createTRPCContext();

export function TRPCProvider({ children, context, dehydratedState }: { children: ReactNode; context?: TRPCContext; dehydratedState?: DehydratedState }) {
  const [current] = useState(() => context ?? browserContext ?? createTRPCContext());
  return (
    <trpc.Provider client={current.trpcClient} queryClient={current.queryClient}>
      <QueryClientProvider client={current.queryClient}>
        <HydrationBoundary state={dehydratedState ?? null}>{children}</HydrationBoundary>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
