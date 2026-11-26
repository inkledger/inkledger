import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/jira";
import { surface } from "@/components/app/surface";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-info-soft text-info",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

const DOTS: Record<Tone, string> = {
  neutral: "bg-muted-foreground/50",
  info: "bg-info/70",
  success: "bg-success/70",
  warning: "bg-warning/70",
  danger: "bg-danger/70",
};

/**
 * Compact label. `dot` (status, priority): neutral chip with a coloured dot,
 * so lists stay tone-on-tone. `soft` (default): tinted fill, reserved for
 * alerts (overdue, queued, errors).
 */
export function Chip({
  tone = "neutral",
  variant = "soft",
  className,
  wrap = false,
  title,
  children,
}: {
  tone?: Tone;
  variant?: "soft" | "dot";
  className?: string;
  /** Long text (a status sentence): wraps inside its box instead of running past it. */
  wrap?: boolean;
  /** The whole text, when what shows may be cut (a clamped status). */
  title?: string;
  children: React.ReactNode;
}) {
  const dot = variant === "dot";
  return (
    <span
      {...surface("chip")}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-1.5 text-caption font-medium",
        wrap ? "min-h-5 max-w-full py-0.5 [overflow-wrap:anywhere]" : "h-5 whitespace-nowrap",
        dot ? "bg-muted text-foreground/75" : TONES[tone],
        className
      )}
    >
      {dot && <Dot tone={tone} className="h-1.5 w-1.5 shrink-0" />}
      {children}
    </span>
  );
}

/** Small round status dot; always pair it with visible or sr-only text. */
export function Dot({
  tone = "neutral",
  className,
}: {
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        DOTS[tone],
        className
      )}
    />
  );
}
