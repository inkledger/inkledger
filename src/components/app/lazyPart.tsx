import { lazy, Suspense, type ComponentType } from "react";
import { ErrorBoundary } from "@/components/app/ErrorBoundary";

let prefetching = 0;

/**
 * Whether a part's code is being fetched ahead of use. Its failure (offline, a redeploy)
 * must not reload the page by itself (main.tsx): it shows where the part opens, if it does.
 */
export const prefetchingParts = () => prefetching > 0;

/** After start, when the browser is free (or soon, where it cannot say). */
function whenIdle(run: () => void) {
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 2000);
}

/**
 * A part of the shell drawn only on demand (a dialog's body), kept out of the first
 * load: its code is fetched when the browser is free after start, so opening it is
 * still immediate. If its code never arrives (a redeploy, the network), the error
 * card shows in its place with "Reload", never instead of the whole app.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  let pending: Promise<{ default: ComponentType<P> }> | undefined;
  const fetchOnce = () => (pending ??= load().then(c => ({ default: c })));
  const Lazy = lazy(fetchOnce);
  whenIdle(() => {
    prefetching++;
    void fetchOnce()
      .catch(() => {})
      .finally(() => prefetching--);
  });
  function Part(props: P) {
    return (
      <ErrorBoundary>
        <Suspense fallback={null}>
          <Lazy {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  }
  return Part;
}
