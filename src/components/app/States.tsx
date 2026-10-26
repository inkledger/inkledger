import { AlertCircle, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Illustration,
  type IllustrationKind,
} from "@/components/app/Illustration";
import { t } from "@/i18n";
import { Spinner } from "@/components/ui/spinner";

/** A page on its way (its code or its first data): a spinner where the page goes. */
export function PageSpinner() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" role="status">
      <Spinner decorative className="h-6 w-6" />
      <span className="sr-only">{t("ui.app.loading")}</span>
    </div>
  );
}

/** Something failed to load; offers a retry. */
export function ErrorState({
  title = t("ui.states.loadFailed"),
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-2 px-4 py-10 text-center",
        className
      )}
    >
      <AlertCircle className="h-6 w-6 text-danger" aria-hidden />
      <p className="font-medium">{title}</p>
      {message && (
        <p className="max-w-md text-body-sm text-muted-foreground">{message}</p>
      )}
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

/** Nothing to show yet; explains what to do next. */
export function EmptyState({
  title,
  message,
  action,
  icon: Icon = Inbox,
  art,
  className,
}: {
  title: string;
  message?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  /** Tone-on-tone illustration instead of the icon. */
  art?: IllustrationKind;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-4 py-10 text-center",
        className
      )}
    >
      {art ? (
        <Illustration kind={art} className="mb-2" />
      ) : (
        <Icon className="h-6 w-6 text-muted-foreground" />
      )}
      <p className="font-medium">{title}</p>
      {message && (
        <p className="max-w-md text-body-sm text-muted-foreground">{message}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
