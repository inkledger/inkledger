import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";
import { isChunkLoadError } from "@/lib/chunkError";

type Props = {
  children: ReactNode;
  /** Changing it (e.g. the route) clears a caught error. */
  resetKey?: string;
  /** Before "Retry" draws again: what the failed drawing read is dropped, so it is read afresh. */
  onRetry?: () => void;
};
type State = { error: unknown; resetKey?: string };

/**
 * A calm fallback instead of a blank page. A render error offers "Retry"
 * (draws again) and "Reload"; a page's code that never arrived (a redeploy,
 * the network) offers "Reload" only, since React.lazy keeps the failure.
 * Around the page it leaves the app's shell in place; at the root it is the
 * last line of defence.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error(t("ui.error.unknown")) };
  }

  static getDerivedStateFromProps(
    props: Props,
    state: State
  ): Partial<State> | null {
    return props.resetKey !== state.resetKey
      ? { error: null, resetKey: props.resetKey }
      : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex min-h-[60vh] items-center justify-center p-4"
      >
        <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border bg-card px-6 py-8 text-center" {...surface("card")}>
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-soft text-primary-strong">
            <TriangleAlert className="h-5 w-5" aria-hidden />
          </span>
          <p className="font-display text-heading">{t("ui.error.title")}</p>
          <p className="text-body-sm text-muted-foreground">
            {t("ui.error.body")}
          </p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            {!isChunkLoadError(this.state.error) && (
              <Button
                variant="outline"
                onClick={() => {
                  this.props.onRetry?.();
                  this.setState({ error: null });
                }}
              >
                {t("common.retry")}
              </Button>
            )}
            <Button onClick={() => window.location.reload()}>
              <RotateCcw className="h-4 w-4" />
              {t("ui.error.reload")}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
