import { BRAND_ARMS, BRAND_HEAD, BRAND_HEAD_OPACITY } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The app's mark: the octopus on a tile painted with the theme's gradient
 * (the sunset band derived from the chosen colour), in the theme's title ink;
 * it follows the colour picker and light/dark by itself.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span data-lit="1" className={cn("cover-sunset flex shrink-0 items-center justify-center rounded-lg text-cover-title", className)}>
      <svg viewBox="5 6 22 20" className="h-[68%] w-[68%]" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={BRAND_HEAD} strokeOpacity={BRAND_HEAD_OPACITY} />
        <path d={BRAND_ARMS} />
      </svg>
    </span>
  );
}
