import { useRef, type RefObject } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { StoreImage } from "./StoreImage";
import type { Slide } from "./Gallery";
import { surface } from "@/components/app/surface";

const SWIPE_PX = 50;

/** The pictures full screen: arrows, ←/→, swipe on touch, Esc to close. */
export function Lightbox({
  slides,
  open,
  index,
  onIndex,
  onOpenChange,
  returnTo,
}: {
  slides: Slide[];
  open: boolean;
  index: number;
  onIndex: (i: number) => void;
  onOpenChange: (open: boolean) => void;
  /** Gets the focus back on close (the slide that opened it). */
  returnTo?: RefObject<HTMLElement | null>;
}) {
  const start = useRef<number | null>(null);
  const go = (d: number) => onIndex((index + d + slides.length) % slides.length);
  const slide = slides[index];
  const many = slides.length > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        cast={false}
        aria-roledescription="carousel"
        onCloseAutoFocus={ev => {
          const back = returnTo?.current;
          if (!back) return;
          ev.preventDefault();
          // After the sheet's own focus scope settles.
          requestAnimationFrame(() => back.focus());
        }}
        onKeyDown={ev => {
          if (ev.key === "ArrowLeft") go(-1);
          if (ev.key === "ArrowRight") go(1);
        }}
        className="w-fit max-w-[96vw] gap-3 border-0 bg-transparent p-0 shadow-none sm:max-w-[96vw]"
      >
        <DialogTitle className="sr-only">{t("settings.store.gallery.label")}</DialogTitle>
        <DialogDescription className="sr-only">{slide?.caption}</DialogDescription>
        <div
          className="relative mx-auto w-fit touch-pan-y select-none overflow-hidden rounded-xl"
          onPointerDown={ev => (start.current = ev.clientX)}
          onPointerUp={ev => {
            if (start.current === null) return;
            const dx = ev.clientX - start.current;
            start.current = null;
            if (Math.abs(dx) > SWIPE_PX) go(dx < 0 ? 1 : -1);
          }}
        >
          <StoreImage key={index} src={slide?.src} alt={slide?.caption} className="block max-h-[82vh] w-auto max-w-full object-contain" />
          {many && (
            <>
              <Arrow side="left" onClick={() => go(-1)} />
              <Arrow side="right" onClick={() => go(1)} />
            </>
          )}
          <DialogClose
            aria-label={t("common.close")}
            {...surface("glass")}
            className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm hover:bg-background"
          >
            <X className="h-5 w-5" aria-hidden />
          </DialogClose>
        </div>
        <div className="flex items-center gap-3 px-1 text-body-sm text-white/90">
          <p className="flex-1">{slide?.caption}</p>
          {many && <span className="tabular text-white/70">{t("settings.store.gallery.position", { n: index + 1, total: slides.length })}</span>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Arrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={t(side === "left" ? "settings.store.gallery.prev" : "settings.store.gallery.next")}
      onClick={onClick}
      {...surface("glass")}
      className={cn(
        "absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm hover:bg-background",
        side === "left" ? "left-3" : "right-3"
      )}
    >
      <Icon className="h-6 w-6" aria-hidden />
    </button>
  );
}
