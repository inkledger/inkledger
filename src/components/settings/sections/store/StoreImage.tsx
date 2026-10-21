import { useState } from "react";
import { Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";

/** A catalog picture (through this server), or a quiet placeholder when missing or broken. */
export function StoreImage({ src, alt = "", className }: { src?: string; alt?: string; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (src && broken !== src) {
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(src)}
        className={cn("bg-muted object-cover", className)}
      />
    );
  }
  return (
    <span className={cn("flex items-center justify-center bg-primary-soft text-primary-strong", className)}>
      <Puzzle className="h-6 w-6" aria-hidden />
    </span>
  );
}
