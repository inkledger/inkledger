import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

type Props = {
  children: ReactNode;
  /** Changing it (e.g. the route) clears a caught error. */
  resetKey?: string;
};
type State = { error: unknown; resetKey?: string };

/**
 * Last line of defence: a render error (or a chunk that failed to load
 * after a redeploy) shows a calm fallback with "Reload" instead of a
 * blank page.
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
        <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border bg-card px-6 py-8 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-soft text-primary-strong">
            <TriangleAlert className="h-5 w-5" aria-hidden />
          </span>
          <p className="font-display text-heading">{t("ui.error.title")}</p>
          <p className="text-body-sm text-muted-foreground">
            {t("ui.error.body")}
          </p>
          <Button className="mt-1" onClick={() => window.location.reload()}>
            <RotateCcw className="h-4 w-4" />
            {t("ui.error.reload")}
          </Button>
        </div>
      </div>
    );
  }
}
