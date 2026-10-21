import { useState } from "react";
import { coverClass } from "@/lib/cover";
import { cn } from "@/lib/utils";

const SIZES = {
  xs: "h-6 w-6 text-2xs",
  sm: "h-7 w-7 text-2xs",
  md: "h-9 w-9 text-overline",
  lg: "h-14 w-14 text-caption font-semibold",
} as const;

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,31}$/;
/** Projects without a Jira icon: asked once per session, then initials only. */
const missing = new Set<string>();

/** A project's initials: its own (APP), a repository's name (owner/firmware → fi), not its owner's. */
const initialsOf = (project: string) => (project.split("/").at(-1) ?? project).slice(0, 2);

/** Round warm-gradient avatar with the project initials (reference: app icons). */
export function ProjectAvatar({
  project,
  label,
  size = "md",
  className,
  transitionName,
  icon = true,
  connectionId,
}: {
  /** The connection the project is on (a project key may be on two sites) */
  connectionId?: number | null;
  /** Seed for the cover colours (project key, person name…) */
  project: string;
  /** Initials to show; defaults to the first two letters of `project` */
  label?: string;
  size?: keyof typeof SIZES;
  className?: string;
  /** Shared-element name for View Transitions (list ↔ detail). */
  transitionName?: string;
  /** Use the Jira project icon when `project` is a project key that has one. */
  icon?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(() => missing.has(project));
  const src =
    icon && !failed && PROJECT_KEY.test(project)
      ? `/api/projects/${project}/avatar${connectionId ? `?c=${connectionId}` : ""}`
      : null;
  return (
    <span
      aria-hidden
      style={
        transitionName ? { viewTransitionName: transitionName } : undefined
      }
      // Under a module's light the round avatars stand out (the large banner keeps its grain).
      data-lit={size === "lg" ? undefined : "1"}
      className={cn(
        // Only the banner clips (its grain); the round ones round their picture instead, so their shadow shows.
        "relative flex shrink-0 items-center justify-center rounded-full font-semibold",
        size === "lg" && "overflow-hidden",
        // Lists stay calm (flat tonal); only the large banner avatar is decorative.
        size === "lg"
          ? cn(
              "grain text-cover-ink ring-1 ring-cover-ink/10",
              coverClass(project)
            )
          : "bg-primary-soft text-primary-strong ring-1 ring-primary-strong/10",
        SIZES[size],
        className
      )}
    >
      {!loaded && (label ?? initialsOf(project))}
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => {
            missing.add(project);
            setFailed(true);
          }}
          className={cn(
            "absolute inset-0 h-full w-full rounded-full bg-card object-contain p-0.5",
            !loaded && "opacity-0"
          )}
        />
      )}
    </span>
  );
}
