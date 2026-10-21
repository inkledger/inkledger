import { useState, type ReactNode } from "react";
import { ExternalLink as ExternalIcon, Lock } from "lucide-react";
import { useAllowedLinks } from "@/hooks/useAllowedLinks";
import { openExternal } from "@/lib/native";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * A link to another site. Allowed domains (Settings → External links, and the
 * Jira site) open in a new tab / the system browser; any other shows its
 * domain behind a lock: one click to allow the domain for good, or to
 * open it just this once.
 */
export function ExternalLink({
  url,
  children,
  className,
}: {
  url: string;
  children: ReactNode;
  className?: string;
}) {
  const { isAllowed, allow } = useAllowedLinks();
  const [open, setOpen] = useState(false);
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();

  if (isAllowed(url)) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className={cn("text-primary-strong underline underline-offset-2 [overflow-wrap:anywhere] hover:text-foreground", className)}
      >
        {children}
      </a>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t("ui.link.title", { host })}
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded-sm text-left text-muted-foreground underline decoration-dotted underline-offset-2 [overflow-wrap:anywhere] hover:text-foreground",
            className
          )}
        >
          <Lock className="h-3 w-3 shrink-0" aria-hidden />
          <span>{children}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <p className="font-medium">{host}</p>
        <p className="mt-1 text-body-sm text-muted-foreground">
          {t("ui.link.body")}
        </p>
        <p className="mt-2 truncate text-caption text-muted-foreground" title={url}>
          {url}
        </p>
        <div className="mt-3 grid gap-2">
          <Button
            size="sm"
            onClick={() =>
              void allow(host).then(d => {
                setOpen(false);
                toast.success(t("ui.link.allowed", { domain: d }), { description: t("ui.link.manage") });
              }, (e: unknown) => toast.error(String(e)))
            }
          >
            {t("ui.link.allowAlways", { host })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOpen(false);
              openExternal(url);
            }}
          >
            <ExternalIcon />
            {t("ui.link.openOnce")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
