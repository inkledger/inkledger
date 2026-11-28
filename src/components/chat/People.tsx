import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { initials } from "@/lib/initials";
import { cn } from "@/lib/utils";


/** A person's avatar: their initials on the covers' warm wash (the same as a comment's author). */
export function PersonAvatar({ name, size = "sm", className }: { name: string; size?: "xs" | "sm" | "md"; className?: string }) {
  return <ProjectAvatar project={name || "?"} label={initials(name || "?")} icon={false} size={size} className={className} />;
}

/** A few people, overlapping, the rest as "+n" (names said once, for assistive tech, by the caller). */
export function AvatarStack({ names, max = 3, size = "xs" }: { names: string[]; max?: number; size?: "xs" | "sm" }) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {shown.map((n, i) => (
        <PersonAvatar key={n + i} name={n} size={size} className={cn(i > 0 && "-ml-1.5 ring-2 ring-card")} />
      ))}
      {rest > 0 && <span className="-ml-1 rounded-full bg-muted px-1.5 text-2xs text-muted-foreground ring-2 ring-card">+{rest}</span>}
    </span>
  );
}
