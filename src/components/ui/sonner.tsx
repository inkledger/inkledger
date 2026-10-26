import { t } from "@/i18n";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { surface } from "@/components/app/surface";

/** A toast floats like a menu (Sonner gives no way to mark it, so it is marked as it appears). */
const TOAST_SURFACE = Object.entries(surface("menu", { elevation: 2 }));
const mark = (root: ParentNode) => {
  for (const el of root.querySelectorAll<HTMLElement>(
    "[data-sonner-toast]:not([data-surface])"
  ))
    for (const [k, v] of TOAST_SURFACE) el.setAttribute(k, v);
};

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  // Watches only the toaster's own box: a toast appears a few times an hour, nothing else moves here.
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    mark(root);
    const watch = new MutationObserver(() => mark(root));
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);

  return (
    <div ref={box} className="contents">
      <Sonner
        theme={theme as ToasterProps["theme"]}
        className="toaster group"
        // Every toast can be closed by hand, without acting on it.
        closeButton
        containerAriaLabel={t("ui.toast.region")}
        toastOptions={{
          closeButtonAriaLabel: t("ui.toast.close"),
          classNames: {
            // No !important shadow: a module drawing the light (Shadow) must be able to replace it.
            toast: "!rounded-xl !font-sans",
            title: "!font-semibold",
            description: "!text-muted-foreground",
            actionButton:
              "!rounded-md !bg-action !px-2.5 !font-medium !text-action-foreground",
            cancelButton: "!rounded-md !bg-muted !text-foreground",
            closeButton:
              "!border-border !bg-popover !text-muted-foreground hover:!text-foreground",
            success: "[&_[data-icon]]:!text-success",
            error: "[&_[data-icon]]:!text-danger",
            warning: "[&_[data-icon]]:!text-warning",
            info: "[&_[data-icon]]:!text-info",
          },
        }}
        icons={{
          success: <CircleCheckIcon className="size-4" />,
          info: <InfoIcon className="size-4" />,
          warning: <TriangleAlertIcon className="size-4" />,
          error: <OctagonXIcon className="size-4" />,
          loading: <Loader2Icon className="size-4 animate-spin" />,
        }}
        style={
          {
            "--normal-bg": "hsl(var(--popover))",
            "--normal-text": "hsl(var(--popover-foreground))",
            "--normal-border": "hsl(var(--border))",
            "--border-radius": "calc(var(--radius) + 0.125rem)",
          } as React.CSSProperties
        }
        {...props}
      />
    </div>
  );
};

export { Toaster };
