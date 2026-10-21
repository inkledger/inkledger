import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // Every toast can be closed by hand, without acting on it.
      closeButton
      toastOptions={{
        classNames: {
          toast: "!rounded-xl !shadow-lg !font-sans",
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
  );
};

export { Toaster };
