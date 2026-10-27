import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { screensaver } from "@/lib/flag";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ModulesContext } from "@/modules/context";
import { ModuleSlot } from "@/modules/ModuleHost";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { canvasScale } from "./loop";
import { freshSeed } from "./scenes/rng";
import type { Scene, ScenePalette } from "./scenes/types";
import { BUILT_IN, sceneList, stepScene } from "./registry";
import { screensaverKey, GRACE_MS } from "./exit";
import { screensaverOverlay, screensaverScene } from "./settings";
import { Overlay } from "./Overlay";

/** How long the overlay and the cursor stay after the pointer last moved. */
const AWAKE_MS = 4000;

/**
 * The screensaver (key "z", the palette, the sidebar, More on phones): a procedural
 * scene over the whole screen, in real fullscreen with the screen kept awake where the
 * browser allows. ← / → switch scene; any other key, a click or a tap closes it, and
 * that press never reaches the app.
 */
export function Screensaver() {
  const open = screensaver.useValue();
  return (
    <Dialog open={open} onOpenChange={screensaver.set}>
      {/* surface: none — the whole screen, not a floating box */}
      <DialogContent
        showCloseButton={false}
        cast={false}
        aria-describedby={undefined}
        className="left-0 top-0 block h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 bg-canvas p-0 shadow-none duration-500 sm:max-w-none data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100"
      >
        <DialogTitle className="sr-only">{t("ui.screensaver.title")}</DialogTitle>
        {open && <Stage />}
      </DialogContent>
    </Dialog>
  );
}

function useSceneChoices() {
  const ctx = useContext(ModulesContext);
  const mods = useMemo(
    () => (ctx?.modules ?? []).map(m => ({ id: m.entry.id, name: m.entry.name, slots: Object.keys(m.module.mount) })),
    [ctx?.modules]
  );
  return useMemo(() => sceneList(mods, currentLocale(), t), [mods]);
}

function Stage() {
  const list = useSceneChoices();
  const [sceneId, setSceneId] = useState(() => screensaverScene.get());
  const [seed, setSeed] = useState(freshSeed);
  const [awake, setAwake] = useState(true);
  const showOverlay = screensaverOverlay.use();
  const choice = list.find(s => s.id === sceneId) ?? list[0];
  const scene = BUILT_IN.find(s => s.id === choice?.id);

  useFullscreen();

  // Keys and presses, before anything in the app sees them.
  const listRef = useRef(list);
  useEffect(() => {
    listRef.current = list;
  }, [list]);
  useEffect(() => {
    const openedAt = performance.now();
    let sleep = setTimeout(() => setAwake(false), AWAKE_MS);
    const wake = () => {
      setAwake(true);
      clearTimeout(sleep);
      sleep = setTimeout(() => setAwake(false), AWAKE_MS);
    };
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    // The click (and touch end) following the closing press would land on the page now uncovered.
    const swallowAfterClose = () => {
      const types = ["click", "pointerup", "mouseup", "touchend", "contextmenu"] as const;
      for (const type of types) window.addEventListener(type, swallow, { capture: true });
      setTimeout(() => {
        for (const type of types) window.removeEventListener(type, swallow, { capture: true });
      }, 600);
    };
    const step = (by: number) => {
      setSceneId(id => stepScene(listRef.current, id, by)?.id ?? id);
      setSeed(freshSeed());
      wake();
    };
    const onKey = (e: KeyboardEvent) => {
      swallow(e);
      const what = screensaverKey(e.key, performance.now() - openedAt);
      if (what === "prev") step(-1);
      else if (what === "next") step(1);
      else if (what === "close") screensaver.set(false);
    };
    const onPress = (e: PointerEvent) => {
      swallow(e);
      if (performance.now() - openedAt < GRACE_MS) return;
      swallowAfterClose();
      screensaver.set(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("pointerdown", onPress, { capture: true });
    window.addEventListener("pointermove", wake, { capture: true, passive: true });
    return () => {
      clearTimeout(sleep);
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("pointerdown", onPress, { capture: true });
      window.removeEventListener("pointermove", wake, { capture: true });
    };
  }, []);

  return (
    <div data-screensaver data-scene={choice?.id} className={cn("absolute inset-0", !awake && "cursor-none")}>
      {scene ? (
        <SceneCanvas key={`${scene.id}:${seed}`} scene={scene} seed={seed} />
      ) : (
        choice?.mod && <ModuleSlot id="screensaver" only={choice.mod} />
      )}
      {showOverlay && <Overlay visible={awake} />}
    </div>
  );
}

/** The theme's colours for a scene: the paper, then the inks (brand first, foreground last). */
function readPalette(): ScenePalette {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => `hsl(${css.getPropertyValue(`--${name}`).trim()})`;
  return {
    paper: token("canvas"),
    inks: [token("primary"), token("chart-focus"), token("chart-other"), token("foreground")],
    dark: document.documentElement.classList.contains("dark"),
  };
}

/** A built-in scene on a canvas filling the screen; started again (same seed) when the size changes. */
function SceneCanvas({ scene, seed }: { scene: Scene; seed: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let running: { stop(): void } | undefined;
    let size = "";
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const start = (force = false) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0 || (!force && `${w}x${h}` === size)) return;
      size = `${w}x${h}`;
      running?.stop();
      const scale = canvasScale(w, h, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      running = scene.start(canvas, {
        seed,
        reducedMotion: motion.matches,
        palette: readPalette(),
      });
    };
    const onMotion = () => start(true);
    motion.addEventListener("change", onMotion);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => start(), size ? 200 : 0);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", onMotion);
      clearTimeout(debounce);
      running?.stop();
    };
  }, [scene, seed]);
  return <canvas ref={ref} aria-hidden className="absolute inset-0 h-full w-full" />;
}

/** Real fullscreen and the screen kept awake while open, where the browser allows; leaving fullscreen (Esc) closes it. */
function useFullscreen() {
  useEffect(() => {
    let entered = false;
    let lock: WakeLockSentinel | null = null;
    let requesting = false;
    let live = true;
    const root = document.documentElement;
    if (!document.fullscreenElement && root.requestFullscreen) {
      // StrictMode discards the first setup before this microtask, so only the live one requests fullscreen.
      queueMicrotask(() => {
        if (!live || document.fullscreenElement) return;
        root.requestFullscreen({ navigationUI: "hide" }).then(
          () => {
            entered = true;
            if (!live) void document.exitFullscreen().catch(() => {});
          },
          () => {}
        );
      });
    }
    const onFullscreen = () => {
      if (!document.fullscreenElement) {
        entered = false;
        screensaver.set(false);
      }
    };
    const awake = async () => {
      if (!live || document.hidden || lock || requesting || !("wakeLock" in navigator)) return;
      requesting = true;
      try {
        const next = await navigator.wakeLock.request("screen");
        requesting = false;
        if (!live || document.hidden) {
          void next.release();
          return;
        }
        lock = next;
        next.addEventListener("release", () => {
          if (lock === next) lock = null;
          void awake();
        }, { once: true });
      } catch {
        requesting = false;
      }
    };
    const onVisibility = () => {
      if (document.hidden) void lock?.release();
      else void awake();
    };
    void awake();
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      document.removeEventListener("fullscreenchange", onFullscreen);
      document.removeEventListener("visibilitychange", onVisibility);
      void lock?.release();
      if (entered && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
}
