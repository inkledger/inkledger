import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { GripHorizontal, MoveDiagonal2 } from "lucide-react";
import type { createFlag } from "@/lib/flag";
import { isTyping } from "@/lib/dom";
import { fitFloat, type FloatShape, type Rect, type floatRectSetting } from "@/lib/pinboardFloat";
import { surface } from "@/components/app/surface";

const STEP = 16;

const viewport = () => ({ vw: window.innerWidth, vh: window.innerHeight });

/**
 * A panel floating over any page, never in the way of the page's keys (not a
 * dialog): moved by its handle and sized from its corner, both kept per
 * device, the arrow keys on either doing the same. It takes the focus only
 * when the user opened it (`focus`); Esc closes it unless something inside
 * already used the key; "/" goes to its search or capture field. The
 * `marker` attribute tells the page's own keys to leave its events alone
 * (inFloat in src/lib/dom.ts).
 */
export function FloatingPanel({
  marker,
  label,
  strings,
  stored,
  shape,
  focus,
  escapeFromFields = false,
  onClose,
  children,
}: {
  marker: "pinboard" | "todo";
  label: string;
  strings: { move: string; moveHint: string; resize: string; resizeHint: string };
  stored: ReturnType<typeof floatRectSetting>;
  shape: FloatShape;
  focus: ReturnType<typeof createFlag>;
  /** Esc closes it from a field too (the TODO capture); the pinboard's fields keep Esc to themselves. */
  escapeFromFields?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [initial] = useState(() => {
    const { vw, vh } = viewport();
    return fitFloat(stored.get(), vw, vh, shape);
  });
  const [rect, setRect] = useState(initial);
  // What a drag or a key last made of it (read between renders).
  const latest = useRef(initial);
  const grab = useRef<{ mode: "move" | "size"; px: number; py: number; from: Rect } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => {
      const { vw, vh } = viewport();
      latest.current = fitFloat(latest.current, vw, vh, shape);
      setRect(latest.current);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [shape]);
  // Opened by the user: the focus goes in, so its keys work at once. Back on
  // another page it doesn't take it: that page's keys keep working.
  // A field marked data-float-autofocus (the TODO capture) takes it instead,
  // as soon as its lazily loaded content is there.
  useEffect(() => {
    if (!focus.get()) return;
    focus.set(false);
    box.current?.focus({ preventScroll: true });
    let frames = 0;
    let raf = 0;
    const field = () => {
      const f = box.current?.querySelector<HTMLElement>("[data-float-autofocus]");
      if (f) {
        if (document.activeElement === box.current) f.focus({ preventScroll: true });
        return;
      }
      if (++frames < 60) raf = requestAnimationFrame(field);
    };
    raf = requestAnimationFrame(field);
    return () => cancelAnimationFrame(raf);
  }, [focus]);

  const place = (next: Rect, keep = false) => {
    const { vw, vh } = viewport();
    const fitted = fitFloat(next, vw, vh, shape);
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
      {...{ [`data-${marker}-float`]: "" }}
      role="region"
      aria-label={label}
      tabIndex={-1}
      {...surface("dialog")}
      className="fixed z-40 flex flex-col overflow-hidden rounded-xl border bg-card outline-none"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onKeyDown={e => {
        if (e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
        // Esc closes it, unless something inside already used it (a note being written, a menu, a field it empties);
        // from a field only when asked (escapeFromFields).
        if (e.key === "Escape" && (escapeFromFields || !isTyping(e.target))) {
          e.preventDefault();
          onClose();
          return;
        }
        if (isTyping(e.target)) return;
        // "/" from anywhere in it (the box itself too, as opened): its search or capture field.
        if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const field = e.currentTarget.querySelector<HTMLInputElement>("[data-float-search], input[type=search]");
          if (!field) return;
          e.preventDefault();
          field.focus();
          return;
        }
      }}
    >
      <button
        type="button"
        aria-label={strings.move}
        title={strings.moveHint}
        className="flex h-5 shrink-0 cursor-move touch-none items-center justify-center text-muted-foreground outline-none hover:bg-accent/60 focus-visible:bg-accent"
        onPointerDown={e => start("move", e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={e => nudge("move", e)}
      >
        <GripHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {children}
      <button
        type="button"
        aria-label={strings.resize}
        title={strings.resizeHint}
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
