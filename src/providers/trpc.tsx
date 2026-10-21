import type { AppRouter } from "../../api/router";
import { httpBatchLink, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { eventsOf } from "@/modules/appEvents";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import superjson from "superjson";
import type { ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { getLocale } from "@/i18n";
import { deviceId } from "@/lib/device";
import { APP_BUILD_CHANGED, APP_BUILD_HEADER, APP_BUILD_META } from "@contracts/appBuild";

/** The build this page's code comes from; none in development. */
const pageBuild = document.querySelector<HTMLMetaElement>(`meta[name="${APP_BUILD_META}"]`)?.content ?? null;

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

/**
 * Session expired or Jira token revoked: forget the current user so the
 * route guard sends the user to /login. auth.me itself is excluded.
 */
function onAuthError(error: unknown, queryKey?: readonly unknown[]) {
  if (reloadForNewBuild(error)) return;
  // A tracker's credentials refused: the connections say so (banner), the user stays in.
  if (error instanceof TRPCClientError && (error.data as { code?: string } | undefined)?.code === "PRECONDITION_FAILED") {
    void queryClient.invalidateQueries({ queryKey: [["connections", "list"]] });
    return;
  }
  if (!isUnauthorized(error)) return;
  const isMeQuery =
    Array.isArray(queryKey?.[0]) &&
    (queryKey[0] as unknown[]).join(".") === "auth.me";
  if (isMeQuery) return;
  queryClient.setQueriesData({ queryKey: [["auth", "me"]] }, null);
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => onAuthError(error, query.queryKey),
  }),
  mutationCache: new MutationCache({
    onError: error => onAuthError(error),
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !isUnauthorized(error) && count < 1,
    },
  },
});

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

const trpcClient = trpc.createClient({
  links: [
    appEventsLink,
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      // The server answers (errors included) in the app's language, and
      // knows the device (its active bucket).
      headers: () => ({ "x-locale": getLocale(), "x-device-id": deviceId(), ...(pageBuild ? { [APP_BUILD_HEADER]: pageBuild } : {}) }),
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

export function TRPCProvider({ children }: { children: ReactNode }) {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
