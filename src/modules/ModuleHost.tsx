import {
  useContext,
  useMemo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { createHub, type Hub } from "./host";
import { loadModules, modulesDisabled, type LoadedModule } from "./loader";
import type { Ambient, SlotId } from "./types";
import { ModulesContext } from "./context";
import { canLight, GLIDE_MS, lightStage } from "./light";
import type { BackdropVisibility } from "@contracts/modules";


let shared: Hub | null = null;
function sharedHub(...args: Parameters<typeof createHub>): Hub {
  shared ??= createHub(...args);
  return shared;
}

/**
 * Loads the active add-on modules and runs the host hub while any is loaded.
 * Without modules (the usual case) it costs one small query.
 */
export function ModulesProvider({ children }: { children: ReactNode }) {
  const disabled = modulesDisabled();
  const list = trpc.modules.list.useQuery(undefined, {
    enabled: !disabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [modules, setModules] = useState<LoadedModule[]>([]);
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const { pathname } = useLocation();

  // Modules this user switched off in the Store stay unloaded.
  // The kill switch wins over data other pages (the Store) put in the shared cache.
  // Not allowed to use modules (useModules): none runs.
  const all = disabled || list.data?.canUse === false ? undefined : list.data?.modules;
  const off = list.data?.off;
  const entries = useMemo(() => all?.filter(e => !off?.includes(e.id)), [all, off]);
  useEffect(() => {
    if (!entries) return;
    let live = true;
    void loadModules(entries).then(m => live && setModules(m));
    return () => {
      live = false;
    };
  }, [entries]);

  // One hub for the app's lifetime, made when the first module loads.
  const hub = modules.length > 0 ? sharedHub(queryClient, utils) : null;

  useEffect(() => {
    hub?.route(pathname);
  }, [hub, pathname]);

  return (
    <ModulesContext.Provider value={hub ? { hub, modules } : null}>
      {children}
    </ModulesContext.Provider>
  );
}

/** Where modules draw: each one offering this slot gets its own box. */
export function ModuleSlot({
  id,
  className,
  frame,
  only,
}: {
  id: SlotId;
  className?: string;
  /** Wraps the boxes (a titled panel), only when some module offers the slot. */
  frame?: (boxes: ReactNode) => ReactNode;
  /** Just this module's box (e.g. its settings in its own Store sheet). */
  only?: string;
}) {
  const ctx = useContext(ModulesContext);
  const mine = ctx?.modules.filter(m => m.module.mount[id] && (!only || m.entry.id === only)) ?? [];
  if (!ctx || mine.length === 0) return null;
  const boxes = (
    <div className={cn("contents", className)} data-module-slot={id}>
      {mine.map(m => (
        <ModuleBox key={m.entry.id} hub={ctx.hub} loaded={m} slot={id} />
      ))}
    </div>
  );
  return frame ? frame(boxes) : boxes;
}

/** Each slot's box: overlays take no room and let clicks through. */
const BOX: Partial<Record<SlotId, string>> = {
  // Drawn over the page: nothing in it takes pointer events (the page under it
  // keeps working); a module makes its shape clickable through host.hitArea.
  "dashboard-overlay": "pointer-events-none absolute inset-0 z-10 [&_*]:!pointer-events-none",
  "panel-edge": "absolute bottom-0 left-0 h-0 w-0",
  // A card of the dashboard grid: the module fills it (canvas, title, controls).
  "dashboard-widget": "relative h-64 min-w-0 overflow-hidden rounded-xl border bg-card",
  // The scene behind the dashboard: blurred by the host, never clickable.
  "dashboard-backdrop": "absolute -inset-4",
  // One small control beside the dashboard title (opens the module's panel).
  "dashboard-action": "flex h-8 items-center",
  // The module's own settings, in its Store sheet.
  settings: "flex min-w-0 flex-col gap-4",
  // One square in the folded sidebar rail.
  "sidebar-rail": "flex h-10 w-10 items-center justify-center",
  // A row in the phone's "More" sheet.
  "mobile-more": "min-w-0",
  // On the tab bar's top edge (phones): takes no room; the module shows a
  // control only while it has something to say (e.g. music playing).
  "mobile-dock": "pointer-events-none absolute bottom-0 right-0 h-0 w-0",
  // Standing on the day timeline's entries, at the bar's left end (DayTimeline
  // places it): a transparent picture; only its shape is clickable (host.hitArea).
  "dashboard-perch": "pointer-events-none absolute inset-0 [&_*]:!pointer-events-none",
};

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The veil's colour in coarse steps: it is the one part that repaints, so only when the colour visibly moves. */
const veilTint = (t: Ambient["tint"]) =>
  t.map(c => Math.min(255, Math.round(c / 6) * 6)).join(" ");

/**
 * A module's light over the Dashboard (host.ambient): every surface marked
 * `data-lit` stands out of the page with a shadow away from the light
 * (lightStage), and a faint veil comes in from the light's side. Both glide
 * on the compositor; nothing restyles the page.
 */
export function DashboardAmbient() {
  const ctx = useContext(ModulesContext);
  const [given, setLight] = useState<Ambient | null>(null);
  // Night turned off (Settings → Appearance): the light without its dark.
  const night = (trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data?.dashboardNight ?? 1) === 1;
  const light = useMemo(() => (given && !night ? { ...given, dim: 0 } : given), [given, night]);
  const anchor = useRef<HTMLSpanElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  const dark = useRef<HTMLDivElement>(null);
  const stage = useRef<ReturnType<typeof lightStage> | null>(null);
  const [lit, setLit] = useState(false);
  // The night covers the whole panel, its sticky header too: drawn in the panel, over the page that scrolls in it.
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  useEffect(() => ctx?.hub.ambient(setLight), [ctx]);
  useEffect(() => {
    // The whole app shell is the stage (sidebar, header, panel); the page only lights while the Dashboard is open.
    const root = anchor.current?.closest<HTMLElement>("[data-lit-stage]");
    if (!light) {
      // Fades out; a light coming back meanwhile picks the stage up again (and this never settles).
      void stage.current?.off().then(() => {
        stage.current = null;
        setLit(false);
      });
      return;
    }
    if (!root || !canLight()) return;
    stage.current ??= lightStage(root, reducedMotion);
    stage.current.set(light);
    setPanel(root.querySelector<HTMLElement>("[data-lit-panel]"));
    setLit(true);
  }, [light]);
  useEffect(() => () => stage.current?.stop(), []);
  // The veil: one picture slid and faded on the compositor towards the light's side.
  useEffect(() => {
    const el = veil.current;
    if (!el) return;
    const to: Keyframe = {
      transform: `translateX(${((light?.from ?? 0) * 27.7).toFixed(2)}%)`,
      opacity: light?.veil ?? 0,
    };
    const was = el.getAnimations()[0];
    const from: Keyframe = was
      ? {
          transform: getComputedStyle(el).transform,
          opacity: getComputedStyle(el).opacity,
        }
      : { ...to, opacity: 0 };
    was?.cancel();
    el.animate([from, to], {
      duration: reducedMotion() ? 1 : GLIDE_MS,
      easing: "ease-in-out",
      fill: "forwards",
    });
  }, [lit, light?.from, light?.veil]);
  // The night: the moon's blue over the panel, as deep as the hour is dark.
  const dim = Math.min(1, Math.max(0, light?.dim ?? 0));
  useEffect(() => {
    const el = dark.current;
    if (!el) return;
    const was = el.getAnimations()[0];
    const from = was ? getComputedStyle(el).opacity : "0";
    was?.cancel();
    el.animate([{ opacity: from }, { opacity: dim.toFixed(3) }], {
      duration: reducedMotion() ? 1 : GLIDE_MS,
      easing: "ease-in-out",
      fill: "forwards",
    });
  }, [lit, dim]);
  const tint = light ? veilTint(light.tint) : null;
  const [lastTint, setLastTint] = useState(tint);
  if (tint && tint !== lastTint) setLastTint(tint);
  return (
    <>
      <span ref={anchor} hidden />
      {lit &&
        panel &&
        createPortal(
          <div aria-hidden className="pointer-events-none absolute inset-0 z-30 overflow-clip rounded-2xl">
            <div ref={dark} data-dashboard-night className="dashboard-night absolute inset-0 opacity-0" />
          </div>,
          panel
        )}
      {lit && lastTint && (
        <div
          aria-hidden
          data-dashboard-light
          className="pointer-events-none absolute inset-0 z-10 overflow-clip rounded-2xl"
        >
          {/* The light's source is outside the page, past the side it comes from: 2.24 panels wide, slid by up to 62% of one. */}
          <div
            ref={veil}
            className="absolute inset-y-0 -left-[62%] -right-[62%] opacity-0 will-change-transform"
            style={{
              background: `radial-gradient(ellipse 42.4% 85% at 50% -10%, rgb(${lastTint}), rgb(${lastTint} / 0) 72%)`,
            }}
          />
        </div>
      )}
    </>
  );
}

/** The Dashboard's backdrop: fills the panel behind the page, veiled so text stays readable. */
// The user's "Backdrop visibility" (Settings → Appearance): blur and veil.
const VISIBILITY: Record<BackdropVisibility, { blur: string; px: number; veil: string }> = {
  subtle: { blur: "blur-[6px]", px: 6, veil: "bg-card/55" },
  normal: { blur: "blur-[5px]", px: 5, veil: "bg-card/40" },
  scenic: { blur: "blur-[3px]", px: 3, veil: "bg-card/[0.28]" },
};

export function DashboardBackdrop() {
  const level = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data?.backdropVisibility ?? "normal";
  const v = VISIBILITY[level as BackdropVisibility] ?? VISIBILITY.normal;
  return (
    <div aria-hidden data-backdrop-visibility={level} className="pointer-events-none absolute inset-0 overflow-clip rounded-2xl">
      <div className="sticky top-0 h-dvh max-h-full overflow-hidden">
        {/* A CSS blur over a layer that changes every frame costs the GPU on every
            frame: a module that bakes the blur into its own picture (drawn small,
            scaled up) marks an element data-preblurred and gets none; it reads
            the wanted radius from --backdrop-blur. */}
        <div className={cn("absolute inset-0 [&:has([data-preblurred])]:filter-none", v.blur)} style={{ "--backdrop-blur": `${v.px}px` } as CSSProperties}>
          <ModuleSlot id="dashboard-backdrop" />
        </div>
        <div className={cn("absolute inset-0", v.veil)} />
      </div>
    </div>
  );
}

function ModuleBox({ hub, loaded, slot }: { hub: Hub; loaded: LoadedModule; slot: SlotId }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const mount = loaded.module.mount[slot];
    if (!el || !mount) return;
    const { api, dispose } = hub.apiFor(loaded.entry.id, slot);
    let unmount: (() => void) | null = null;
    try {
      unmount = mount(el, api);
    } catch (e) {
      console.error(`[module ${loaded.entry.id}] mount failed`, e);
    }
    return () => {
      try {
        unmount?.();
      } catch (e) {
        console.error(`[module ${loaded.entry.id}] unmount failed`, e);
      }
      dispose();
      el.replaceChildren();
    };
  }, [hub, loaded, slot]);
  return <div ref={ref} data-module={loaded.entry.id} className={BOX[slot]} />;
}
