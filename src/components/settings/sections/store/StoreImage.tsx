import { useState } from "react";
import { Puzzle } from "lucide-react";
import { coverClass } from "@/lib/cover";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";

/** A catalog picture (through this server), or a placeholder when missing or broken. */
/** `picture`: the image stands on its own (an icon tile); inside a clipping card it does not. */
/**
 * `name`: the module's, so the placeholder is its own (a grainy cover seeded by the name, with its
 * initial, like a project's picture) instead of the same puzzle piece for every module.
 */
export function StoreImage({ src, alt = "", className, picture = false, name }: { src?: string; alt?: string; className?: string; picture?: boolean; name?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (src && broken !== src) {
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(src)}
        {...surface("picture", { on: picture })}
        className={cn("bg-muted object-cover", className)}
      />
    );
  }
  const initial = name?.trim().charAt(0).toUpperCase();
  if (initial) {
    return (
      <span
        aria-hidden
        {...surface("picture", { on: picture })}
        className={cn(
          "grain flex items-center justify-center font-display font-semibold text-cover-ink ring-1 ring-inset ring-cover-ink/10",
          picture ? "text-heading" : "text-display",
          coverClass(name ?? ""),
          className
        )}
      >
        {initial}
      </span>
    );
  }
  return (
    <span {...surface("picture", { on: picture })} className={cn("flex items-center justify-center bg-primary-soft text-primary-strong", className)}>
      <Puzzle className="h-6 w-6" aria-hidden />
    </span>
  );
}
