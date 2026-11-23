import type { BudgetLevel } from "../hostV2";

/**
 * Keeps framed modules within the page's budget. Framed modules share one
 * process (Chrome puts every sandboxed frame of the app's site in one), so
 * process-wide signals can't tell them apart: each frame beats twice a second
 * with its own long tasks since the last beat, the host times the beats, reads
 * long tasks it can attribute to a frame, and watches its own frame gaps. A
 * module that keeps failing steps down a ladder, one step per bad second:
 * warn, "reduce", "still", paused (hidden, which throttles its drawing), then
 * stopped for the session. Ten clean seconds step it back up one.
 */

/** The ladder, mildest first. */
export const STEPS = ["normal", "warn", "reduce", "still", "paused", "killed"] as const;
export type Step = (typeof STEPS)[number];

/** How often a frame beats. */
export const BEAT_MS = 500;
/** How often the ladder is judged. */
export const TICK_MS = 1000;
/** A beat this overdue is late (an offscreen frame's timers fire about once a second). */
const LATE_MS = 2000;
/** A runtime frame is never on screen: its timers may run slower. */
const LATE_RUNTIME_MS = 3000;
/** Startup (import, first draw) is not judged. */
const GRACE_MS = 2000;
/** A long task is one of 50 ms or more: any of them is over the budget. */
const LONG_TASK_MS = 50;
/** Clean ticks before a module steps back up. */
const RECOVER_TICKS = 10;
/** Host lag past which a window says nothing about whose beat was late. */
const HOST_LAG_MS = 250;
/** Where frames share the page's thread: lagging ticks in a row after which the page's lag is held against its modules. */
const LAG_TICKS = 3;
/** A gap this long is a sleep (a laptop lid), not a module. */
const SLEEP_MS = 10_000;
/** The page's own time on a module's messages in one second, past which it is the module's fault (the plan: 3 ms a frame). */
const HOST_WORK_MS = 180;
/** A module seen busy this recently is the one stalling the frames it shares a process with. */
const BLAME_MS = 3000;
/** Seconds of flooding the page with messages, within FLOOD_WINDOW_MS, that stop a module (the first holds it to "reduce"). */
const FLOOD_STOP = 3;
const FLOOD_WINDOW_MS = 10_000;

export const budgetOfStep = (step: Step): BudgetLevel => (step === "reduce" ? "reduce" : STEPS.indexOf(step) >= STEPS.indexOf("still") ? "still" : "normal");

type FrameState = { moduleId: string; runtime: boolean; started: number; judgeFrom: number; lastBeat: number; busy: number; hostMs: number; suspended: boolean; flooded: boolean };
type ModuleState = { step: number; clean: number; blamedAt: number; floods: number[] };

export type LadderFrame = {
  /** A beat, with the frame's own long-task time since the last one. */
  beat(busyMs: number): void;
  /** A long task the host attributed to this frame. */
  longTask(ms: number): void;
  /** It sent more messages than the page may read: dropped, and counted against it. */
  flood(): void;
  /** Time the page itself spent on its messages. */
  hostWork(ms: number): void;
  /** Off screen or the page hidden: its beats slow down, lateness is not judged. */
  suspend(on: boolean): void;
  dispose(): void;
};

/**
 * The ladder alone, on a given clock: `tick` once per TICK_MS with how late the host itself ran.
 * What can't be pinned on a module (late beats, and with `judgeLag` the page lagging, where frames
 * share its thread and long tasks are not reported) asks it to reduce, never more: only its own
 * long tasks, the page's work on its messages or a flood of them step it further, so one module
 * never gets the others stopped.
 */
export function createLadder(o: { now: () => number; onStep: (moduleId: string, step: Step) => void; judgeLag?: boolean }) {
  const frames = new Set<FrameState>();
  let lagTicks = 0;
  const modules = new Map<string, ModuleState>();
  const mod = (id: string) => {
    const m = modules.get(id) ?? { step: 0, clean: 0, blamedAt: -Infinity, floods: [] };
    modules.set(id, m);
    return m;
  };
  const set = (id: string, m: ModuleState, step: number) => {
    if (m.step === step) return;
    m.step = step;
    o.onStep(id, STEPS[step]);
  };

  return {
    frame(moduleId: string, role: "view" | "runtime"): LadderFrame {
      const t = o.now();
      const f: FrameState = { moduleId, runtime: role === "runtime", started: t, judgeFrom: t + GRACE_MS, lastBeat: t, busy: 0, hostMs: 0, suspended: false, flooded: false };
      frames.add(f);
      mod(moduleId);
      return {
        beat(busyMs) {
          f.lastBeat = o.now();
          f.busy += Math.max(0, busyMs);
        },
        longTask(ms) {
          if (ms >= LONG_TASK_MS) f.busy += ms;
        },
        flood() {
          f.flooded = true;
        },
        hostWork(ms) {
          f.hostMs += Math.max(0, ms);
        },
        suspend(on) {
          if (f.suspended === on) return;
          f.suspended = on;
          // Back on screen: its timers catch up first.
          const now = o.now();
          f.lastBeat = now;
          f.judgeFrom = Math.max(f.judgeFrom, now + GRACE_MS);
        },
        dispose: () => void frames.delete(f),
      };
    },
    tick(hostLagMs: number) {
      const t = o.now();
      const lagging = hostLagMs > HOST_LAG_MS;
      const struck = new Set<string>();
      const late = new Set<string>();
      const flooded = new Set<string>();
      const hostMs = new Map<string, number>();
      const lagged = new Set<string>();
      for (const f of frames) {
        const m = mod(f.moduleId);
        if (m.step === STEPS.indexOf("killed")) continue;
        // Flooding costs the page whatever else happened, startup included.
        if (f.flooded) flooded.add(f.moduleId);
        f.flooded = false;
        hostMs.set(f.moduleId, (hostMs.get(f.moduleId) ?? 0) + f.hostMs);
        f.hostMs = 0;
        // Its own long tasks are its own, whatever else happened.
        if (f.busy >= LONG_TASK_MS && t > f.started + GRACE_MS) {
          struck.add(f.moduleId);
          m.blamedAt = t;
        }
        f.busy = 0;
        if (f.suspended || t <= f.judgeFrom) continue;
        // The host itself ran late (its own jank, a sleep): every beat looks late, none is judged.
        if (lagging) {
          f.lastBeat = t;
          lagged.add(f.moduleId);
          continue;
        }
        if (t - f.lastBeat > (f.runtime ? LATE_RUNTIME_MS : LATE_MS)) late.add(f.moduleId);
      }
      // The page's work on a module's messages is its own, the page lagging or not.
      for (const [id, ms] of hostMs)
        if (ms >= HOST_WORK_MS) {
          struck.add(id);
          mod(id).blamedAt = t;
        }
      lagTicks = lagging && hostLagMs < SLEEP_MS ? lagTicks + 1 : 0;
      // Late while another module was busy: stalled by it, not guilty. Late, or the page lagging on
      // and on where frames share its thread, with nobody to blame: each is asked to reduce.
      const someoneBusy = [...modules.values()].some(m => t - m.blamedAt <= BLAME_MS);
      const unexplained = new Set<string>();
      for (const id of late) if (t - mod(id).blamedAt <= BLAME_MS) struck.add(id);
      if (!someoneBusy) {
        late.forEach(id => unexplained.add(id));
        if (o.judgeLag && lagTicks >= LAG_TICKS) lagged.forEach(id => unexplained.add(id));
      }
      const watched = new Set([...frames].map(f => f.moduleId));
      for (const [id, m] of modules) {
        if (m.step === STEPS.indexOf("killed") || !watched.has(id)) continue;
        if (flooded.has(id)) {
          // Paused or not, a frame still posts: reduce at once, then stopped if it keeps on.
          m.floods = [...m.floods.filter(at => t - at < FLOOD_WINDOW_MS), t];
          m.clean = 0;
          set(id, m, m.floods.length >= FLOOD_STOP ? STEPS.indexOf("killed") : Math.max(m.step, STEPS.indexOf("reduce")));
        } else if (struck.has(id)) {
          m.clean = 0;
          set(id, m, m.step + 1);
        } else if (unexplained.has(id)) {
          m.clean = 0;
          if (m.step < STEPS.indexOf("reduce")) set(id, m, m.step + 1);
        } else if (m.step > 0 && ++m.clean >= RECOVER_TICKS) {
          m.clean = 0;
          set(id, m, m.step - 1);
        }
      }
    },
    step: (moduleId: string): Step => STEPS[modules.get(moduleId)?.step ?? 0],
    /** Frames left to watch. */
    size: () => frames.size,
  };
}

// ---- Modules stopped this session, for the Store's status ----

const stopped = new Map<string, string>();
const stoppedListeners = new Set<() => void>();
let stoppedSnapshot: ReadonlyMap<string, string> = new Map();

/** A module stopped until the page reloads, and why ("slow", "navigated"). */
export function markStopped(moduleId: string, why: "slow" | "navigated") {
  if (stopped.has(moduleId)) return;
  stopped.set(moduleId, why);
  stoppedSnapshot = new Map(stopped);
  stoppedListeners.forEach(f => f());
}
export const stoppedModules = {
  get: (): ReadonlyMap<string, string> => stoppedSnapshot,
  subscribe: (fn: () => void) => {
    stoppedListeners.add(fn);
    return () => void stoppedListeners.delete(fn);
  },
};

// ---- The page's watchdog: the ladder over real frames ----

type Pause = "offscreen" | "hidden" | "ladder";
type Watched = { moduleId: string; iframe: HTMLIFrameElement; frame: LadderFrame; pauses: Set<Pause> };

const watched = new Set<Watched>();
const budgets = new Map<string, Set<(b: BudgetLevel) => void>>();
const killers = new Map<string, (why: string) => void>();
let ladder: ReturnType<typeof createLadder> | null = null;
/** Whether the engine reports long tasks: where it doesn't (WebKit), frames may share the page's thread and its lag is theirs. */
const longTasks = () => typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes?.includes("longtask") === true;
// One ladder for the session: a module keeps its step across remounts.
const theLadder = () => (ladder ??= createLadder({ now: () => performance.now(), onStep, judgeLag: !longTasks() }));
let timer: ReturnType<typeof setInterval> | null = null;
let raf = 0;
let lastRaf = 0;
let worstRaf = 0;
let lastTick = 0;
let seen: IntersectionObserver | null = null;
let tasks: PerformanceObserver | null = null;

const apply = (w: Watched) => {
  w.iframe.style.visibility = w.pauses.size > 0 ? "hidden" : "";
};

function onStep(moduleId: string, step: Step) {
  for (const w of watched) {
    if (w.moduleId !== moduleId) continue;
    w.iframe.dataset.watch = step;
    if (step === "paused") w.pauses.add("ladder");
    else w.pauses.delete("ladder");
    apply(w);
  }
  if (step === "warn") console.warn(`[module ${moduleId}] over the page's budget`);
  const level = budgetOfStep(step);
  budgets.get(moduleId)?.forEach(f => f(level));
  if (step === "killed") killers.get(moduleId)?.("it slowed the page");
}

const frameTick = (t: number) => {
  if (lastRaf) worstRaf = Math.max(worstRaf, t - lastRaf);
  lastRaf = t;
  raf = requestAnimationFrame(frameTick);
};

const onVisibility = () => {
  const hidden = document.hidden;
  for (const w of watched) {
    if (hidden) w.pauses.add("hidden");
    else w.pauses.delete("hidden");
    w.frame.suspend(hidden || w.pauses.has("offscreen"));
    apply(w);
  }
  // No frames are drawn while hidden: the gap says nothing.
  lastRaf = 0;
  lastTick = performance.now();
};

function start() {
  lastTick = performance.now();
  timer = setInterval(() => {
    const t = performance.now();
    const lag = Math.max(t - lastTick - TICK_MS, worstRaf);
    lastTick = t;
    worstRaf = 0;
    theLadder().tick(document.hidden ? 0 : lag);
  }, TICK_MS);
  raf = requestAnimationFrame(frameTick);
  document.addEventListener("visibilitychange", onVisibility);
  if (typeof IntersectionObserver === "function") {
    seen = new IntersectionObserver(
      entries => {
        for (const e of entries) {
          const w = [...watched].find(x => x.iframe === e.target);
          if (!w) continue;
          if (e.isIntersecting) w.pauses.delete("offscreen");
          else w.pauses.add("offscreen");
          w.frame.suspend(!e.isIntersecting || w.pauses.has("hidden"));
          apply(w);
        }
      },
      // Woken a little before it scrolls in: never a blank card on screen.
      { rootMargin: "200px" },
    );
  }
  // Long tasks the page can pin on a frame (where frames share the page's thread).
  if (longTasks()) {
    tasks = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        const src = (e as PerformanceEntry & { attribution?: { containerSrc?: string }[] }).attribution?.[0]?.containerSrc;
        if (!src) continue;
        for (const w of watched) if (w.iframe.src === src) w.frame.longTask(e.duration);
      }
    });
    tasks.observe({ type: "longtask" });
  }
}

function stop() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  cancelAnimationFrame(raf);
  raf = 0;
  lastRaf = 0;
  worstRaf = 0;
  document.removeEventListener("visibilitychange", onVisibility);
  seen?.disconnect();
  seen = null;
  tasks?.disconnect();
  tasks = null;
}

/**
 * Watches one module frame from now on; `kill` stops the whole module. View
 * frames off screen are paused (hidden) until they're back; the runtime
 * frame, never on screen, is not. Returns its beat and its undo.
 */
export function watchFrame(moduleId: string, iframe: HTMLIFrameElement, role: "view" | "runtime", kill: (why: string) => void) {
  if (watched.size === 0) start();
  const l = theLadder();
  killers.set(moduleId, kill);
  const w: Watched = { moduleId, iframe, frame: l.frame(moduleId, role), pauses: new Set() };
  watched.add(w);
  iframe.dataset.watch = l.step(moduleId);
  if (l.step(moduleId) === "paused") w.pauses.add("ladder");
  if (document.hidden) {
    w.pauses.add("hidden");
    w.frame.suspend(true);
  }
  apply(w);
  if (role === "view") seen?.observe(iframe);
  return {
    beat: (busyMs: number) => w.frame.beat(busyMs),
    flood: () => w.frame.flood(),
    hostWork: (ms: number) => w.frame.hostWork(ms),
    dispose() {
      if (!watched.delete(w)) return;
      seen?.unobserve(iframe);
      w.frame.dispose();
      if (watched.size === 0) stop();
    },
  };
}

/** The budget a module is held to now, and on every change. */
export function budgetOf(moduleId: string) {
  return (fn: (b: BudgetLevel) => void) => {
    const set = budgets.get(moduleId) ?? new Set();
    budgets.set(moduleId, set);
    set.add(fn);
    fn(budgetOfStep(ladder?.step(moduleId) ?? "normal"));
    return () => void set.delete(fn);
  };
}
