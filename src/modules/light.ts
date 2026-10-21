// A module's light over the Dashboard (host.ambient), drawn as depth: every
// surface marked `data-lit="<height>"` (above what it stands on) casts a
// shadow away from the light from its ::after (further and softer the higher
// it stands). The light catching their top edge (::before) is plain CSS,
// faded in and out with the light (index.css, data-lit-shown).
// The shadows are followed in glides, never in steps: they stay put until
// the light has drifted a little under a pixel (every few minutes), then
// glide there over a few seconds with Web Animations on transform and
// opacity (the compositor's work, no repaint). At rest no animation is left:
// each shadow's place is plain style on its surface (--lit-x/-y/-a, not
// inherited, so writing it restyles only that surface), so the page carries
// no extra layers between glides. Custom properties on :root would restyle
// the whole page at every change, a frame lost on weak machines.

import type { Ambient } from "./types";

/** Shadow offset per unit of the light's lean, per level of depth (px). */
const STEP = 5;
/** The shadows follow once the light has drifted this far (px at the deepest level, or opacity). */
const MOVE_PX = 0.8;
const MOVE_A = 0.05;
export const GLIDE_MS = 2500;
/** On a machine that can't glide them smoothly, the shadows follow only once this far behind (px), at once. */
const STILL_PX = 3;
/** A glide is too much for this machine when this many of its frames come late (over 20 ms). */
const LATE_FRAMES = 6;

/**
 * Whether this machine has shown it can't glide the shadows smoothly (for
 * the session, across Dashboard visits): from then on they are set in one
 * go, rarely, instead of gliding.
 */
let still = false;
/** Glides that came out late so far: two, and the machine is judged (one could be a busy moment). */
let rough = 0;
const MAX_DEPTH = 3;

export type Pose = { dx: number; dy: number; a: number };

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/**
 * How soft the shadows are, ×1 at noon to ×1.6: a low light (a long lean)
 * and the night blur them. Written on the stage only when it changes by more
 * than a tenth (a custom property every shadow reads: a restyle of them all).
 */
export const softnessOf = (l: Ambient) => {
  const low = clamp((Math.hypot(l.x, l.y) - 1) / 1.5, 0, 1);
  return 1 + 0.6 * Math.max(low, clamp(l.dim ?? 0, 0, 1));
};
const SOFTNESS_STEP = 0.1;

/** After this much dark the shadows turn cool (moonlight). */
export const NIGHT_FROM = 0.5;

let software: boolean | null = null;
/**
 * Whether the page is drawn without a GPU (SwiftShader, llvmpipe): a blurred
 * layer per surface would cost too much there, the shadows stay box-shadows.
 */
export function softwareRendering(): boolean {
  if (software !== null) return software;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    software = !gl || /swiftshader|llvmpipe|software|basic render/i.test(renderer);
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    software = false;
  }
  return software;
}

/** The light as a shadow pose: lean per level of depth and how dark (1 = the theme's look at noon). */
export const poseOf = (l: Ambient): Pose => ({
  dx: l.x * STEP,
  dy: l.y * STEP,
  a: clamp(l.strength / 1.3, 0, 1),
});

export const OFF: Pose = { dx: 0, dy: STEP, a: 0 };

/** Whether the light has moved enough to follow it (a glide), or too little to see yet. */
export const glides = (from: Pose, to: Pose) =>
  Math.max(Math.abs(to.dx - from.dx), Math.abs(to.dy - from.dy)) * MAX_DEPTH >
    MOVE_PX || Math.abs(to.a - from.a) > MOVE_A;

/** Ease in and out (smoothstep): the glide's shape, also used to know where an interrupted glide stands. */
const ease = (t: number) => t * t * (3 - 2 * t);
const STOPS = 8;

export const between = (a: Pose, b: Pose, t: number): Pose => {
  const k = ease(clamp(t, 0, 1));
  return {
    dx: a.dx + (b.dx - a.dx) * k,
    dy: a.dy + (b.dy - a.dy) * k,
    a: a.a + (b.a - a.a) * k,
  };
};

const cast = (p: Pose, depth: number): Keyframe => ({
  transform: `translate(${(p.dx * depth).toFixed(2)}px, ${(p.dy * depth).toFixed(2)}px)`,
  opacity: +p.a.toFixed(3),
});

/** Linear stops along the eased path: the compositor runs them as given. */
const path = (from: Pose, to: Pose, frame: (p: Pose) => Keyframe): Keyframe[] =>
  Array.from({ length: STOPS + 1 }, (_, i) => ({
    ...frame(between(from, to, i / STOPS)),
    offset: i / STOPS,
  }));

/** Whether this browser can animate ::before/::after (otherwise the Dashboard stays as it is). */
export function canLight() {
  if (typeof document === "undefined" || typeof KeyframeEffect === "undefined")
    return false;
  try {
    const a = document
      .createElement("div")
      .animate([{ opacity: 1 }], { duration: 1, pseudoElement: "::after" });
    const ok = (a.effect as KeyframeEffect | null)?.pseudoElement === "::after";
    a.cancel();
    return ok;
  } catch {
    return false;
  }
}

/** A surface's shadow at rest: plain style, read by its ::after (index.css). */
const rest = (el: HTMLElement, p: Pose, depth: number) => {
  el.style.setProperty("--lit-x", (p.dx * depth).toFixed(2));
  el.style.setProperty("--lit-y", (p.dy * depth).toFixed(2));
  el.style.setProperty("--lit-a", p.a.toFixed(3));
};
const unrest = (el: HTMLElement) => {
  for (const k of ["--lit-x", "--lit-y", "--lit-a"]) el.style.removeProperty(k);
  el.removeAttribute("data-lit-own");
};

/**
 * Whether a surface paints its own layer (a transform, even none at all, a
 * filter, isolation…): its shadow, behind it at z-index -1, would then be
 * drawn over its own background. Such a surface keeps a box-shadow, drawn
 * outside its box only (data-lit-own).
 */
export function ownLayer(cs: Pick<CSSStyleDeclaration, "transform" | "filter" | "isolation" | "opacity" | "zIndex" | "willChange" | "contain" | "mixBlendMode" | "backdropFilter">) {
  return (
    cs.transform !== "none" ||
    cs.filter !== "none" ||
    cs.backdropFilter !== "none" ||
    cs.isolation === "isolate" ||
    Number(cs.opacity) < 1 ||
    cs.zIndex !== "auto" ||
    /transform|opacity|filter/.test(cs.willChange) ||
    /paint|layout|strict|content/.test(cs.contain) ||
    cs.mixBlendMode !== "normal"
  );
}

/**
 * Lights the surfaces under `root` (and those added later). `set` moves the
 * light; `off` fades it out and resolves once nothing is left drawn.
 */
export function lightStage(root: HTMLElement, reduced: () => boolean) {
  /** Each lit surface, and its glide while one runs. */
  const lit = new Map<HTMLElement, Animation | null>();
  let from = OFF;
  let to = OFF;
  let start = 0;
  let duration = 0;
  let settling = 0;
  const born = performance.now();

  const depthOf = (el: Element) =>
    clamp(Number(el.getAttribute("data-lit")) || 2, 1, MAX_DEPTH);
  /** Where the light is drawn right now (mid-glide: on its way). */
  const now = (): Pose =>
    duration > 0
      ? between(from, to, (performance.now() - start) / duration)
      : to;

  /** Its shadow rests where the light goes; while gliding an animation carries it there. */
  const place = (el: HTMLElement, at: number) => {
    lit.get(el)?.cancel();
    const depth = depthOf(el);
    rest(el, to, depth);
    if (duration <= 0) return lit.set(el, null);
    const glide = el.animate(
      path(from, to, p => cast(p, depth)),
      { duration, fill: "forwards", easing: "linear", pseudoElement: "::after" }
    );
    glide.currentTime = at;
    lit.set(el, glide);
  };

  const track = (el: Element) => {
    if (!(el instanceof HTMLElement) || lit.has(el)) return;
    // A wrapper's face stands over its shadow whatever the wrapper is.
    if (!el.hasAttribute("data-lit-wrap") && ownLayer(getComputedStyle(el))) el.setAttribute("data-lit-own", "");
    // Joins a glide under way where it stands.
    place(el, performance.now() - start);
  };

  const untrack = (el: Element) => {
    if (!(el instanceof HTMLElement) || !lit.has(el)) return;
    lit.get(el)?.cancel();
    unrest(el);
    lit.delete(el);
  };

  const scan = (node: Node) => {
    if (!(node instanceof Element)) return;
    if (node.hasAttribute("data-lit")) track(node);
    node.querySelectorAll("[data-lit]").forEach(track);
  };

  const observer = new MutationObserver(records => {
    let removed = false;
    for (const r of records) {
      // A surface that became lit (an item turned active) or stopped being.
      if (r.type === "attributes") {
        const el = r.target as Element;
        if (el.hasAttribute("data-lit")) track(el);
        else untrack(el);
        continue;
      }
      r.addedNodes.forEach(scan);
      removed ||= r.removedNodes.length > 0;
    }
    if (removed)
      for (const el of lit.keys()) if (!el.isConnected) lit.delete(el);
  });

  root.setAttribute("data-lit-on", "");
  if (softwareRendering()) root.setAttribute("data-lit-soft", "");
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-lit"],
  });
  scan(root);

  /** Counts a glide's late frames; too many, and this machine stops gliding. */
  const watch = (ms: number) => {
    let last = 0,
      late = 0;
    const until = performance.now() + ms;
    const tick = (t: number) => {
      if (last && t - last > 20) late++;
      last = t;
      if (late >= LATE_FRAMES) {
        still = ++rough >= 2;
        // Visible to tests and measurements.
        if (still) root.setAttribute("data-lit-still", "");
      } else if (t < until && !still) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const move = (target: Pose, force = false) => {
    const here = now();
    // Too small to see yet: the shadows stay where they are, the drift adds up.
    if (!force && !glides(here, target)) return;
    // A machine that can't glide: set at once, and only once well behind.
    if (
      still &&
      !force &&
      Math.max(Math.abs(target.dx - here.dx), Math.abs(target.dy - here.dy)) *
        MAX_DEPTH <
        STILL_PX &&
      Math.abs(target.a - here.a) < 0.15
    )
      return;
    const ms = reduced() || still ? 0 : GLIDE_MS;
    clearTimeout(settling);
    from = here;
    to = target;
    start = performance.now();
    duration = ms;
    for (const el of lit.keys()) place(el, 0);
    if (!ms) return;
    // The first seconds of the page (loading, the tree drawn) don't count against the machine.
    if (performance.now() - born > 8000) watch(ms);
    // Arrived: the animations go, the shadows rest in plain style (same place, no jump).
    settling = window.setTimeout(() => {
      duration = 0;
      for (const [el, glide] of lit) {
        glide?.cancel();
        lit.set(el, null);
      }
    }, ms + 50);
  };

  let softness = 1;
  /** Softness and the night's cool shadows: rarely, only on a real change. */
  const shade = (l: Ambient) => {
    const k = softnessOf(l);
    if (Math.abs(k - softness) / softness > SOFTNESS_STEP || (k === 1 && softness !== 1)) {
      softness = k;
      if (k === 1) root.style.removeProperty("--lit-blur");
      else root.style.setProperty("--lit-blur", k.toFixed(2));
    }
    root.toggleAttribute("data-lit-night", (l.dim ?? 0) >= NIGHT_FROM);
  };

  let ending: number | null = null;
  return {
    set(l: Ambient) {
      if (ending !== null) {
        clearTimeout(ending);
        ending = null;
      }
      root.setAttribute("data-lit-on", "");
      if (still) root.setAttribute("data-lit-still", "");
      // Next frame: the edges' light fades in (a CSS transition from the hidden state).
      requestAnimationFrame(() => root.setAttribute("data-lit-shown", ""));
      shade(l);
      move(poseOf(l));
    },
    /** Fades out, then takes every trace away. */
    off(): Promise<void> {
      root.removeAttribute("data-lit-shown");
      move({ ...now(), a: 0 }, true);
      return new Promise(resolve => {
        ending = window.setTimeout(
          () => {
            stop();
            resolve();
          },
          reduced() || still ? 0 : GLIDE_MS + 60
        );
      });
    },
    stop,
  };

  function stop() {
    observer.disconnect();
    clearTimeout(settling);
    for (const [el, glide] of lit) {
      glide?.cancel();
      unrest(el);
    }
    lit.clear();
    root.removeAttribute("data-lit-on");
    root.removeAttribute("data-lit-shown");
    root.removeAttribute("data-lit-still");
    root.removeAttribute("data-lit-soft");
    root.removeAttribute("data-lit-night");
    root.style.removeProperty("--lit-blur");
  }
}
