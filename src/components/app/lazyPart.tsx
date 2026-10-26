import { lazy, Suspense, useState, type ComponentType } from "react";
import { ErrorBoundary } from "@/components/app/ErrorBoundary";

const partFailures = new WeakSet<object>();

/**
 * Whether a failed import was a part's (main.tsx asks once the import has settled). A part's
 * failure (offline, a redeploy) must not reload the page by itself: it shows where the part
 * opens. Told by the failure itself, never by timing: a page's chunk failing meanwhile still
 * reloads.
 */
export const isPartFailure = (e: unknown): boolean => typeof e === "object" && e !== null && partFailures.has(e);

/** How long after the page's load the parts are fetched: never competing with the page's own content. */
const AFTER_LOAD_MS = 1500;

/** After start, once the page has loaded and shown its content, when the browser is free. */
function whenIdle(run: () => void) {
  const idle = () => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 5000 });
    else run();
  };
  const later = () => setTimeout(idle, AFTER_LOAD_MS);
  if (document.readyState === "complete") later();
  else window.addEventListener("load", later, { once: true });
}

/**
 * A part of the shell drawn only on demand (a dialog's body), kept out of the first
 * load: its code is fetched when the browser is free after start, so opening it is
 * still immediate. If its code never arrives (a redeploy, the network), the error
 * card shows in its place with "Reload", never instead of the whole app. As for a page,
 * only a reload fetches it again: the browser keeps a module that failed to load.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  let pending: Promise<{ default: ComponentType<P> }> | undefined;
  // Its code once here: drawn as is. React.lazy suspends on its first render however long
  // the code has been here, and then holds the content back ~300 ms after the fallback.
  let loaded: ComponentType<P> | undefined;
  const fetchOnce = () =>
    (pending ??= load().then(
      c => ((loaded = c), { default: c }),
      (e: unknown) => {
        if (typeof e === "object" && e !== null) partFailures.add(e);
        throw e;
      },
    ));
  const Lazy = lazy(fetchOnce);
  whenIdle(() => void fetchOnce().catch(() => {}));
  function Part(props: P) {
    // Chosen once per mount: a body that switched from Lazy to the code itself would remount,
    // losing what was typed in it.
    const [Body] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return (
      <ErrorBoundary>
        <Suspense fallback={null}>
          <Body {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  }
  return Part;
}
