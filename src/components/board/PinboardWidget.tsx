import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useLocation } from "react-router";
import { GripHorizontal, MoveDiagonal2 } from "lucide-react";
import { pinboardFloat, pinboardFloatFocus } from "@/lib/flag";
import { deviceSetting } from "@/lib/storage";
import { isTyping } from "@/lib/dom";
import { floatHidden, usePinboardSurfacesNow } from "@/hooks/usePinboardPanel";
import { lazyPart } from "@/components/app/lazyPart";
import { fitFloat, type Rect } from "@/lib/pinboardFloat";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { surface } from "@/components/app/surface";
import { t } from "@/i18n";

const Pinboard = lazyPart(() => import("@/components/board/Pinboard").then(m => m.Pinboard));

const STEP = 16;

const stored = deviceSetting<Rect | null>(
  "ikl-pinboard-float",
  raw => {
    try {
      const v: unknown = raw === null ? null : JSON.parse(raw);
      if (typeof v !== "object" || v === null) return null;
      const { x, y, w, h } = v as Record<string, unknown>;
      return [x, y, w, h].every(n => typeof n === "number" && Number.isFinite(n)) ? { x, y, w, h } as Rect : null;
    } catch {
      return null;
    }
  },
  v => (v === null ? null : JSON.stringify(v)),
);

const viewport = () => ({ vw: window.innerWidth, vh: window.innerHeight });

/**
 * The pinboard over any page, never in the way of the page's keys: floating,
 * moved by its handle and sized from its corner (kept per device), not a
 * dialog; on small screens a sheet from the bottom. It gives way where the
 * pinboard already is (its page, the Board with its panel): mounted once.
 */
export function PinboardWidget() {
  const open = pinboardFloat.useValue();
  const { pathname } = useLocation();
  const surfaces = usePinboardSurfacesNow();
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const shown = open && surfaces.widget && !floatHidden(pathname);
  const close = () => pinboardFloat.set(false);

  if (!wide) {
    return (
      <Sheet open={shown} onOpenChange={pinboardFloat.set}>
        <SheetContent side="bottom" hideClose className="flex h-[85dvh] flex-col rounded-t-2xl p-3">
          <SheetTitle className="sr-only">{t("pages.board.pinboard")}</SheetTitle>
          <SheetDescription className="sr-only">{t("pages.board.pinboardDescription")}</SheetDescription>
          {shown && <Pinboard className="min-h-0 flex-1" resizable={false} onClose={close} />}
        </SheetContent>
      </Sheet>
    );
  }
  return shown ? <Floating onClose={close} /> : null;
}

function Floating({ onClose }: { onClose: () => void }) {
  const [initial] = useState(() => {
    const { vw, vh } = viewport();
    return fitFloat(stored.get(), vw, vh);
  });
  const [rect, setRect] = useState(initial);
  // What a drag or a key last made of it (read between renders).
  const latest = useRef(initial);
  const grab = useRef<{ mode: "move" | "size"; px: number; py: number; from: Rect } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => {
      const { vw, vh } = viewport();
      latest.current = fitFloat(latest.current, vw, vh);
      setRect(latest.current);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Opened by the user: the focus goes in, so its keys work at once. Back on
  // another page it doesn't take it: that page's keys keep working.
  useEffect(() => {
    if (!pinboardFloatFocus.get()) return;
    pinboardFloatFocus.set(false);
    box.current?.focus({ preventScroll: true });
  }, []);

  const place = (next: Rect, keep = false) => {
    const { vw, vh } = viewport();
    const fitted = fitFloat(next, vw, vh);
    latest.current = fitted;
    setRect(fitted);
    if (keep) stored.set(fitted);
  };
  const start = (mode: "move" | "size", e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { mode, px: e.clientX, py: e.clientY, from: latest.current };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const g = grab.current;
    if (!g) return;
    const dx = e.clientX - g.px;
    const dy = e.clientY - g.py;
    place(g.mode === "move" ? { ...g.from, x: g.from.x + dx, y: g.from.y + dy } : { ...g.from, w: g.from.w + dx, h: g.from.h + dy });
  };
  const end = (e: PointerEvent<HTMLElement>) => {
    if (!grab.current) return;
    grab.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    stored.set(latest.current);
  };
  const nudge = (mode: "move" | "size", e: KeyboardEvent<HTMLElement>) => {
    const d: Record<string, [number, number]> = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
    const m = d[e.key];
    if (!m) return;
    e.preventDefault();
    const r = latest.current;
    place(mode === "move" ? { ...r, x: r.x + m[0], y: r.y + m[1] } : { ...r, w: r.w + m[0], h: r.h + m[1] }, true);
  };

  return (
    <div
      ref={box}
      data-pinboard-float
      role="region"
      aria-label={t("ui.pinboardFloat.label")}
      tabIndex={-1}
      {...surface("dialog")}
      className="fixed z-40 flex flex-col overflow-hidden rounded-xl border bg-card outline-none"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onKeyDown={e => {
        if (e.defaultPrevented || isTyping(e.target) || !e.currentTarget.contains(e.target as Node)) return;
        // "/" from anywhere in it (the box itself too, as opened): its search.
        if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const field = e.currentTarget.querySelector<HTMLInputElement>("input[type=search]");
          if (!field) return;
          e.preventDefault();
          field.focus();
          return;
        }
        // Esc closes it, unless something inside already used it (a note being written, a menu).
        if (e.key !== "Escape") return;
        e.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        aria-label={t("ui.pinboardFloat.move")}
        title={t("ui.pinboardFloat.moveHint")}
        className="flex h-5 shrink-0 cursor-move touch-none items-center justify-center text-muted-foreground outline-none hover:bg-accent/60 focus-visible:bg-accent"
        onPointerDown={e => start("move", e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={e => nudge("move", e)}
      >
        <GripHorizontal className="h-4 w-4" aria-hidden />
      </button>
      <Pinboard className="min-h-0 flex-1 px-3 pb-3" resizable={false} onClose={onClose} />
      <button
        type="button"
        aria-label={t("ui.pinboardFloat.resize")}
        title={t("ui.pinboardFloat.resizeHint")}
        className="absolute bottom-0 right-0 flex h-5 w-5 cursor-nwse-resize touch-none items-center justify-center rounded-tl-md text-muted-foreground outline-none hover:bg-accent/60 focus-visible:bg-accent"
        onPointerDown={e => start("size", e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={e => nudge("size", e)}
      >
        <MoveDiagonal2 className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
