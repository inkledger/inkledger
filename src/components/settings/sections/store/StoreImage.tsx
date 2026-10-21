import { useState } from "react";
import { Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";

/** A catalog picture (through this server), or a quiet placeholder when missing or broken. */
/** `picture`: the image stands on its own (an icon tile); inside a clipping card it does not. */
export function StoreImage({ src, alt = "", className, picture = false }: { src?: string; alt?: string; className?: string; picture?: boolean }) {
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
  return (
    <span {...surface("picture", { on: picture })} className={cn("flex items-center justify-center bg-primary-soft text-primary-strong", className)}>
      <Puzzle className="h-6 w-6" aria-hidden />
    </span>
  );
}
