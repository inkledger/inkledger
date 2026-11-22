import { RotateCcw } from "lucide-react";
import { Component, lazy, Suspense, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { ErrorBoundary } from "@/components/app/ErrorBoundary";
import { ErrorState } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/errorText";
import { t } from "@/i18n";

const partFailures = new WeakSet<object>();

/**
 * Whether a failed import was a part's (main.tsx asks once the import has settled). A part's
 * failure (offline, a redeploy) must not reload the page by itself: it shows where the part
 * opens. Told by the failure itself, never by timing: a page's chunk failing meanwhile still
 * reloads.
 */
export const isPartFailure = (e: unknown): boolean => typeof e === "object" && e !== null && partFailures.has(e);

/** Claims a failed import as a part's: shown where it was needed, never a reload of the whole page. */
export function claimPartFailure(e: unknown): void {
  if (typeof e === "object" && e !== null) partFailures.add(e);
}

/** How long after the page's load the parts are fetched: never competing with the page's own content. */
const AFTER_LOAD_MS = 1500;

/** After start, once the page has loaded and shown its content, when the browser is free. */
function whenIdle(run: () => void) {
  if (typeof window === "undefined") return;
  const idle = () => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 5000 });
    else run();
  };
  const later = () => setTimeout(idle, AFTER_LOAD_MS);
  if (document.readyState === "complete") later();
  else window.addEventListener("load", later, { once: true });
}

type MissingProps = { children: ReactNode; open: boolean; inline: boolean; retried: boolean; onRetry: () => void };

const reload = () => window.location.reload();

/**
 * A part whose code never arrived: nothing in the shell while closed. Opened, a body inside its
 * dialog says so in place; a whole dialog (nothing to draw it in) says so in a toast. Both offer
 * Retry; once a retry failed too, Reload (a redeploy removed the file: only a new page finds it).
 * Any other error goes on to the boundary around it.
 */
class Missing extends Component<MissingProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(t("ui.error.unknown")) };
  }

  componentDidCatch(error: unknown) {
    if (!isPartFailure(error) || !this.props.open || this.props.inline) return;
    toastError(error, { action: this.props.retried ? { label: t("ui.error.reload"), onClick: reload } : { label: t("common.retry"), onClick: this.props.onRetry } });
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!isPartFailure(error)) throw error;
    if (!this.props.inline || !this.props.open) return null;
    return (
      <div className="flex flex-col items-center pb-6">
        <ErrorState className="pb-2 pt-6" onRetry={this.props.onRetry} />
        {this.props.retried && (
          <Button size="sm" onClick={reload}>
            <RotateCcw className="h-4 w-4" />
            {t("ui.error.reload")}
          </Button>
        )}
      </div>
    );
  }
}

/**
 * A part of the shell drawn only on demand (a dialog's body), kept out of the first
 * load: its code is fetched when the browser is free after start, so opening it is
 * still immediate. `useOpen` tells, from outside its code, whether it is open: one
 * always mounted draws nothing (and fetches nothing) until then or until its code is
 * here. Without it, the part is open while mounted. If its code never arrives (a
 * redeploy, the network), it is fetched again when opened again or on Retry.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>, useOpen?: (props: P) => boolean): ComponentType<P> {
  let pending: Promise<{ default: ComponentType<P> }> | undefined;
  // Its code once here: drawn as is. React.lazy suspends on its first render however long
  // the code has been here, and then holds the content back ~300 ms after the fallback.
  let loaded: ComponentType<P> | undefined;
  let failed = false;
  const arrived = new Set<() => void>();
  const fetchOnce = () =>
    (pending ??= load().then(
      c => {
        loaded = c;
        arrived.forEach(f => f());
        return { default: c };
      },
      (e: unknown) => {
        claimPartFailure(e);
        failed = true;
        pending = undefined;
        throw e;
      },
    ));
  let Lazy = lazy(fetchOnce);
  // React.lazy keeps a failure: a new try needs a new one.
  const body = (): ComponentType<P> => {
    if (loaded) return loaded;
    if (failed) {
      failed = false;
      Lazy = lazy(fetchOnce);
    }
    return Lazy;
  };
  const subscribe = (f: () => void) => {
    arrived.add(f);
    return () => void arrived.delete(f);
  };
  const isHere = () => loaded !== undefined;
  whenIdle(() => void fetchOnce().catch(() => {}));
  const useIsOpen = useOpen ?? (() => true);
  function Part(props: P) {
    const open = useIsOpen(props);
    const here = useSyncExternalStore(subscribe, isHere, isHere);
    // Chosen once (when first wanted): a body that switched from Lazy to the code itself
    // would remount, losing what was typed in it.
    const [Body, setBody] = useState<ComponentType<P> | null>(() => (open || here ? body() : null));
    const [tries, setTries] = useState(0);
    const [wasOpen, setWasOpen] = useState(open);
    const retry = () => {
      const next = body();
      setBody(() => next);
      setTries(n => n + 1);
    };
    if (Body === null && (open || here)) {
      const next = body();
      setBody(() => next);
    }
    if (open !== wasOpen) {
      setWasOpen(open);
      // Opened again with its code still missing: fetched again (a failure is kept per try).
      if (open && !here && Body !== null) retry();
    }
    if (Body === null) return null;
    return (
      <ErrorBoundary>
        <Missing key={tries} open={open} inline={!useOpen} retried={tries > 0} onRetry={retry}>
          <Suspense fallback={null}>
            <Body {...props} />
          </Suspense>
        </Missing>
      </ErrorBoundary>
    );
  }
  return Part;
}
