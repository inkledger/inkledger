import {
  useContext,
  useMemo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { createHub, type Hub } from "./host";
import { loadModules, modulesDisabled, type LoadedModule } from "./loader";
import type { SlotId } from "./types";
import { ModulesContext } from "./context";
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

  // Not allowed any more (or switched off): none of the loaded ones keeps running.
  const running = useMemo(() => (entries ? modules.filter(m => entries.some(e => e.id === m.entry.id)) : []), [entries, modules]);

  // One hub while any module runs: made when the first loads, let go after the last.
  const hub = running.length > 0 ? sharedHub(queryClient, utils) : null;
  useEffect(() => {
    if (running.length === 0 && shared) {
      shared.dispose();
      shared = null;
    }
  }, [running.length]);

  useEffect(() => {
    hub?.route(pathname);
  }, [hub, pathname]);

  return (
    <ModulesContext.Provider value={hub ? { hub, modules: running } : null}>
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
  // App-wide and unseen (a module's light over every page): mounted once, never with a page.
  "app-stage": "hidden",
  // The whole screen while the screensaver shows this module's scene.
  screensaver: "absolute inset-0",
};

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
