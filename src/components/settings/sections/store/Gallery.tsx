import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Expand } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { Lightbox } from "./Lightbox";
import { StoreImage } from "./StoreImage";

export type Slide = { src?: string; caption: string };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Product pictures: a large slide that cross-fades to the next every few
 * seconds (paused on hover and focus, off with reduced motion), arrows and
 * ←/→, thumbnails, the caption below; a click opens them full screen.
 */
export function Gallery({ slides }: { slides: Slide[] }) {
  const [index, setIndex] = useState(0);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [full, setFull] = useState(false);
  const current = useRef<HTMLButtonElement>(null);
  const [reduced] = useState(reducedMotion);
  if (slides.length === 0) return null;
  const i = Math.min(index, slides.length - 1);
  const go = (d: number) => setIndex((i + d + slides.length) % slides.length);
  const many = slides.length > 1;
  const autoplay = many && !reduced && !full;
  const paused = hover || focus;

  return (
    <section
      aria-roledescription="carousel"
      aria-label={t("settings.store.gallery.label")}
      tabIndex={many ? 0 : undefined}
      onKeyDown={ev => {
        if (ev.key === "ArrowLeft") go(-1);
        if (ev.key === "ArrowRight") go(1);
      }}
      onFocus={() => setFocus(true)}
      onBlur={ev => !ev.currentTarget.contains(ev.relatedTarget) && setFocus(false)}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative aspect-[16/10] overflow-hidden rounded-xl border bg-muted">
        {slides.map((s, n) => (
          <button
            key={n}
            type="button"
            ref={n === i ? current : undefined}
            tabIndex={n === i ? 0 : -1}
            aria-hidden={n !== i}
            aria-label={t("settings.store.gallery.fullscreen")}
            onClick={() => setFull(true)}
            className={cn(
              "group absolute inset-0 cursor-zoom-in transition-opacity duration-700",
              n === i ? "opacity-100" : "pointer-events-none opacity-0"
            )}
          >
            <StoreImage src={s.src} alt={n === i ? s.caption : ""} className="h-full w-full" />
            <span className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-background/85 text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Expand className="h-4 w-4" aria-hidden />
            </span>
          </button>
        ))}
        {many && (
          <>
            <GalleryArrow side="left" onClick={() => go(-1)} />
            <GalleryArrow side="right" onClick={() => go(1)} />
            <span className="absolute bottom-2 right-2 rounded-md bg-background/85 px-1.5 text-caption tabular text-muted-foreground">
              {t("settings.store.gallery.position", { n: i + 1, total: slides.length })}
            </span>
          </>
        )}
        {autoplay && (
          // Its animation is the clock: when it ends, the next slide.
          <span
            key={i}
            aria-hidden
            data-gallery-progress
            onAnimationEnd={() => go(1)}
            className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-primary/70"
            style={{ animation: "store-gallery-progress 5s linear forwards", animationPlayState: paused ? "paused" : "running" }}
          />
        )}
      </div>
      <p className="mt-2 min-h-5 text-body-sm text-muted-foreground" aria-live={autoplay && !paused ? "off" : "polite"}>
        {slides[i]?.caption}
      </p>
      {many && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {slides.map((s, n) => (
            <button
              key={n}
              type="button"
              aria-label={t("settings.store.gallery.show", { n: n + 1 })}
              aria-current={n === i}
              onClick={() => setIndex(n)}
              className={cn(
                "shrink-0 overflow-hidden rounded-md border-2 transition-opacity",
                n === i ? "border-primary" : "border-transparent opacity-70 hover:opacity-100"
              )}
            >
              <StoreImage src={s.src} className="aspect-[16/10] w-20" />
            </button>
          ))}
        </div>
      )}
      <Lightbox slides={slides} open={full} index={i} onIndex={setIndex} onOpenChange={setFull} returnTo={current} />
    </section>
  );
}

function GalleryArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={t(side === "left" ? "settings.store.gallery.prev" : "settings.store.gallery.next")}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm transition-colors hover:bg-background",
        side === "left" ? "left-2" : "right-2"
      )}
    >
      <Icon className="h-5 w-5" aria-hidden />
    </button>
  );
}
