import type { QueryClient } from "@tanstack/react-query";
import type { trpc } from "@/lib/trpc";
import { focusMode, screensaver } from "@/lib/flag";
import { expectedSeconds, scheduleFor, workBounds } from "@contracts/workSchedule";
import { FILE_TYPES } from "@contracts/modules";
import { onAppEvent } from "./appEvents";
import { currentLocale } from "@/i18n";
import { hitAreas } from "./hit";
import { SURFACES } from "@/components/app/surface";
import type { ThemeStateV2 } from "./hostV2";
import type {
  HostApiV1,
  HostEventName,
  HostEvents,
  SlotId,
  Sub,
  ThemeState,
  TimerState,
  TodayState,
} from "./types";
import { prefersReducedMotion } from "@/lib/dom";
import { softwareRender } from "./render";
import { runningTimers } from "@/lib/timerFocus";

/**
 * The page side of the host API: one hub per app, fed by the React Query cache
 * (what the app already loads), the theme and a few app flags. Modules only
 * read; their storage goes through tRPC. Every module callback is guarded: a
 * module that throws never breaks the page or another module.
 */

type Utils = ReturnType<typeof trpc.useUtils>;

const guard = (moduleId: string, fn: () => unknown) => {
  const fail = (e: unknown) => console.error(`[module ${moduleId}]`, e);
  try {
    const r = fn();
    // An async callback that rejects is caught too: never an unhandled rejection in the page.
    if (r instanceof Promise) r.catch(fail);
  } catch (e) {
    fail(e);
  }
};

/** A module that never reads its storage still hears closures, after this long. */
const CLOSED_READY_MS = 10_000;

/** storage.update: tries before giving up on a key that keeps changing elsewhere. */
const UPDATE_TRIES = 8;

/** What a stopped module's late read gets: no answer (never made-up data it could save). */
const never = <T,>() => new Promise<T>(() => {});

/** A value with subscribers that get the latest at once (same value: no call). */
function store<T>(initial: T) {
  let value = initial;
  let key = JSON.stringify(initial);
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set(next: T) {
      const k = JSON.stringify(next);
      if (k === key) return;
      value = next;
      key = k;
      subs.forEach(fn => fn(next));
    },
    subscribe(fn: (v: T) => void) {
      subs.add(fn);
      fn(value);
      return () => void subs.delete(fn);
    },
  };
}

const toBase64 = async (b: Blob) => {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (data: string, type: string) => new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type });

/** Rank of a Jira priority by name (English or Italian), 0 = highest; null if unknown. */
export function priorityRank(name: string): number | null {
  const n = name.trim().toLowerCase();
  const ranks: [number, string[]][] = [
    [0, ["highest", "blocker", "critical", "massima", "bloccante", "critica"]],
    [1, ["high", "major", "alta", "maggiore"]],
    [2, ["medium", "media", "normale"]],
    [3, ["low", "minor", "bassa", "minore"]],
    [4, ["lowest", "trivial", "minima", "banale"]],
  ];
  return ranks.find(([, names]) => names.includes(n))?.[0] ?? null;
}

const TOKENS = ["primary", "foreground", "muted", "card", "border", "background", "ring"] as const;

function readTheme(night = true): ThemeStateV2 {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const tokens = Object.fromEntries(
    TOKENS.map(t => [t, `hsl(${css.getPropertyValue(`--${t}`).trim()})`])
  ) as ThemeState["tokens"];
  return {
    mode: root.classList.contains("dark") ? "dark" : "light",
    reducedMotion: prefersReducedMotion(),
    tokens,
    night,
    softwareRender: softwareRender(),
    // The night's dimming as the light on the page sets it (framed modules can't read :root).
    skyDim: Math.min(1, Math.max(0, Number.parseFloat(css.getPropertyValue("--sky-dim")) || 0)),
  };
}

export type Hub = ReturnType<typeof createHub>;

export function createHub(queryClient: QueryClient, utils: Utils) {
  const timer = store<TimerState>({ state: "idle", issueKey: null });
  const today = store<TodayState>({ loggedSeconds: 0, goalSeconds: null, workTime: false });
  // Night on the Dashboard as the person set it (Settings → Appearance); on by default.
  const nightOf = () => (utils.settings.get.getData()?.dashboardNight ?? 1) === 1;
  const theme = store<ThemeStateV2>(readTheme(nightOf()));
  // The module whose settings sheet is open (ModuleSettingsSheet).
  const settingsOf = store<string | null>(null);
  const listeners = new Map<HostEventName, Set<(d: never) => void>>();

  const emit = <E extends HostEventName>(event: E, detail: HostEvents[E]) =>
    listeners.get(event)?.forEach(fn => (fn as (d: HostEvents[E]) => void)(detail));

  // ---- Derived from the cache: what changed since the last look ----
  let lastStatus = new Map<string, { status: string; category: string }>();
  // Null until the timer list first arrives: the timers running then are recorded, not told as started.
  let lastRunning: Set<string> | null = null;
  // The data objects the last look walked: the same object again (another cache event) is not walked twice.
  let seenTimers: unknown;
  let seenIssues: unknown;
  let lastLogged: number | null = null;
  let goalDay = "";
  // Each module hearing issue-closed: what asks the server for its new closures.
  const closureAsks = new Set<() => void>();

  const look = () => {
    // Only the night preference may have changed in the cache (no style read on every look).
    const night = nightOf();
    if (theme.get().night !== night) theme.set({ ...theme.get(), night });
    const timers = utils.timers.list.getData();
    if (timers && timers !== seenTimers) {
      seenTimers = timers;
      // Timers side by side: a module sees the one started last.
      const runningNow = runningTimers(timers);
      const running = runningNow[0];
      const paused = timers.find(t => t.state === "paused");
      timer.set(
        running
          ? { state: "running", issueKey: running.issueKey }
          : paused
            ? { state: "paused", issueKey: paused.issueKey }
            : { state: "idle", issueKey: null }
      );
      // By identity, as the other events: the same key on two trackers is two timers. Each one that starts, once.
      const ids = new Set(runningNow.map(r => `${r.connectionId ?? ""}:${r.issueKey}`));
      for (const r of lastRunning ? [...runningNow].reverse() : []) {
        if (lastRunning?.has(`${r.connectionId ?? ""}:${r.issueKey}`)) continue;
        emit("timer-started", { issueKey: r.issueKey, ...(r.connectionId ? { ref: { connectionId: r.connectionId, key: r.issueKey } } : {}) });
      }
      lastRunning = ids;
    }

    const issues = utils.issues.all.getData();
    if (issues && issues !== seenIssues) {
      seenIssues = issues;
      // By identity: two trackers may share a key.
      const idOf = (i: { connectionId: number; key: string }) => `${i.connectionId}:${i.key}`;
      const next = new Map(issues.map(i => [idOf(i), { status: i.status, category: i.category }]));
      for (const i of issues) {
        const before = lastStatus.get(idOf(i));
        if (!before || before.status === i.status) continue;
        const ref = { connectionId: i.connectionId, key: i.key };
        emit("issue-moved", { issueKey: i.key, from: before.status, to: i.status, ref });
      }
      lastStatus = next;
      // Closures are the server's (made anywhere, also while the app was closed): asked again now.
      closureAsks.forEach(ask => ask());
    }

    const stats = utils.stats.dashboard.getData();
    const settings = utils.settings.get.getData();
    const versions = utils.workSchedule.list.getData();
    const ownDays = utils.workSchedule.days.getData();
    if (stats) {
      const now = new Date();
      const bounds = versions ? workBounds(now, scheduleFor(now, versions, ownDays)) : null;
      // Today's goal: the work schedule's (today's own hours when it has them), as the Dashboard counts it.
      const goal = versions ? expectedSeconds(now, scheduleFor(now, versions, ownDays)) || null : (settings?.dailyTargetSeconds ?? null);
      today.set({
        loggedSeconds: stats.todaySeconds,
        goalSeconds: goal,
        workTime: bounds !== null && now >= bounds.start && now < bounds.end,
      });
      const day = now.toDateString();
      if (goal && stats.todaySeconds >= goal && goalDay !== day && lastLogged !== null && lastLogged < goal) {
        goalDay = day;
        emit("goal-reached", {});
      }
      lastLogged = stats.todaySeconds;
    }
  };

  // Logs, edits and stops as the server confirmed them (the tRPC link): told once, never guessed from totals.
  const unsubApp = onAppEvent((event, detail) => emit(event, detail as never));

  let scheduled = false;
  const unsubCache = queryClient.getQueryCache().subscribe(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      look();
    });
  });
  // What the hub needs even on pages that don't load it.
  const prefetch = () => {
    void utils.timers.list.prefetch();
    void utils.stats.dashboard.prefetch();
    void utils.settings.get.prefetch();
    void utils.workSchedule.list.prefetch();
    void utils.workSchedule.days.prefetch();
  };
  prefetch();
  const refresh = setInterval(() => {
    void utils.stats.dashboard.invalidate();
    look();
    closureAsks.forEach(ask => ask());
  }, 60_000);

  const themeObserver = new MutationObserver(() => theme.set(readTheme(nightOf())));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onMotion = () => theme.set(readTheme(nightOf()));
  motion.addEventListener("change", onMotion);
  const unsubFocus = focusMode.subscribe(() => emit("focus-mode", { on: focusMode.get() }));
  const unsubScreensaver = screensaver.subscribe(() => emit("screensaver", { on: screensaver.get() }));

  look();

  return {
    emit,
    route: (pathname: string) => emit("route", { pathname }),
    /** Which module's settings sheet is open; close with null. */
    settingsOpen: (fn: (moduleId: string | null) => void) => settingsOf.subscribe(fn),
    closeSettings: () => settingsOf.set(null),
    /** The signed-in account's id (a framed module's cache is kept under it); null when signed out. */
    account: (): number | null => utils.auth.me.getData()?.id ?? null,

    /** The API one module gets in one slot. */
    apiFor(moduleId: string, slot: SlotId) {
      const owned = new Set<() => void>();
      let disposed = false;
      // A module stopped meanwhile (licence removed, switched off): its last
      // reads and writes settle quietly instead of failing in the page.
      const quiet = async <T,>(call: () => Promise<T>, fallback: T): Promise<T> => {
        if (disposed) return fallback;
        try {
          return await call();
        } catch (e) {
          const code = (e as { data?: { code?: string } } | null)?.data?.code;
          if (disposed || code === "FORBIDDEN") return fallback;
          throw e;
        }
      };
      // Data reads: once stopped (or refused) they stay unanswered; there is no empty value to fake.
      const read = async <T,>(call: () => Promise<T>): Promise<T> => {
        if (disposed) return never<T>();
        try {
          return await call();
        } catch (e) {
          const code = (e as { data?: { code?: string } } | null)?.data?.code;
          if (disposed || code === "FORBIDDEN") return never<T>();
          throw e;
        }
      };
      const own = (off: () => void) => {
        owned.add(off);
        return () => {
          off();
          owned.delete(off);
        };
      };
      // issue-closed: this module's closures, claimed on the server (each told once to it, whichever tab asks), told as they come, all at once.
      const closedFns = new Set<(d: HostEvents["issue-closed"]) => void>();
      let claiming = false;
      let askAgain = false;
      // Nothing claimed before the module read its saved state (or a while passed): a closure told earlier would be dropped.
      let closedReady = false;
      let readyWait: ReturnType<typeof setTimeout> | undefined;
      const stateRead = () => {
        if (closedReady) return;
        closedReady = true;
        clearTimeout(readyWait);
        if (closedFns.size > 0) askClosed();
      };
      const claimClosed = async () => {
        if (disposed || closedFns.size === 0 || !closedReady) return;
        if (claiming) {
          askAgain = true;
          return;
        }
        claiming = true;
        askAgain = false;
        try {
          const got = await utils.client.modules.claimClosures.mutate({ moduleId });
          // Claimed is told at once: the page never holds one it could lose.
          for (const c of got) {
            if (disposed) break;
            const d = { issueKey: c.issueKey, priorityRank: c.priorityRank ?? priorityRank(c.priority), ref: { connectionId: c.connectionId, key: c.issueKey } };
            closedFns.forEach(fn => fn(d));
          }
          // A full step may have more behind it.
          if (got.length > 0) askAgain = true;
        } catch {
          // Refused or offline: the next look asks again.
        } finally {
          claiming = false;
        }
        if (askAgain) void claimClosed();
      };
      const askClosed = () => void claimClosed();
      // Nothing added after a stop: dispose has already let go of what it owned.
      const sub =
        <T>(s: { subscribe: (fn: (v: T) => void) => () => void }): Sub<T> =>
        fn =>
          disposed ? () => {} : own(s.subscribe(v => guard(moduleId, () => fn(v))));
      const api: HostApiV1 = {
        version: 1,
        moduleId,
        slot,
        locale: currentLocale() === "it" ? "it" : "en",
        timer: sub(timer),
        today: sub(today),
        theme: sub(theme),
        // Fresh every time: a module asks after an event, when hours just changed.
        totals: () => read(() => utils.modules.totals.fetch({ moduleId }, { staleTime: 0 })),
        history: { daily: (since?: number) => read(() => utils.modules.historyDaily.fetch({ moduleId, ...(since === undefined ? {} : { since }) }, { staleTime: 60_000 })) },
        weather: ({ lat, lon }) => read(() => utils.modules.weather.fetch({ moduleId, lat, lon }, { staleTime: 10 * 60_000 })),
        geocode: query =>
          read(() => utils.modules.geocode.fetch({ moduleId, query, language: currentLocale() === "it" ? "it" : "en" })),
        // Since the Shadow module the host draws no light: kept so older modules still load.
        ambient() {},
        surfaces: { catalog: () => SURFACES },
        stage: {
          root: () => document.querySelector<HTMLElement>("[data-surface-stage]"),
          panel: () => document.querySelector<HTMLElement>("[data-surface-panel]"),
        },
        openSettings() {
          if (!disposed) settingsOf.set(moduleId);
        },
        hitArea(el, test, activate) {
          if (disposed) return () => {};
          return own(
            hitAreas().add(
              el,
              (x, y, w, h) => {
                // A module whose test throws is never hit: the page keeps the click.
                let hit = false;
                guard(moduleId, () => {
                  hit = test(x, y, w, h) === true;
                });
                return hit;
              },
              () => guard(moduleId, activate)
            )
          );
        },
        on(event, fn) {
          if (disposed) return () => {};
          if (event === "issue-closed") {
            const wrapped = (d: HostEvents["issue-closed"]) => guard(moduleId, () => (fn as (d: HostEvents["issue-closed"]) => void)(d));
            closedFns.add(wrapped);
            if (closedFns.size === 1) {
              closureAsks.add(askClosed);
              if (closedReady) queueMicrotask(askClosed);
              else readyWait ??= setTimeout(stateRead, CLOSED_READY_MS);
            }
            return own(() => {
              closedFns.delete(wrapped);
              if (closedFns.size > 0) return;
              closureAsks.delete(askClosed);
              clearTimeout(readyWait);
              readyWait = undefined;
            });
          }
          const set = listeners.get(event) ?? new Set();
          listeners.set(event, set);
          const wrapped = (d: never) => guard(moduleId, () => fn(d));
          set.add(wrapped);
          if (event === "screensaver") {
            queueMicrotask(() => {
              if (!disposed && set.has(wrapped)) wrapped({ on: screensaver.get() } as never);
            });
          }
          return own(() => set.delete(wrapped));
        },
        files: {
          get: key =>
            quiet(async () => {
              const r = await utils.client.modules.fileGet.query({ moduleId, key });
              return r ? fromBase64(r.data, r.contentType) : null;
            }, null),
          put: async (key, file) => {
            const type = FILE_TYPES.find(t => t === file.type);
            if (!type) throw new Error(`files: ${file.type || "this type"} is not webp, png or avif`);
            const data = await toBase64(file);
            await quiet(() => utils.client.modules.filePut.mutate({ moduleId, key, contentType: type, data }), undefined);
          },
          delete: async key => {
            await quiet(() => utils.client.modules.fileDelete.mutate({ moduleId, key }), undefined);
          },
        },
        storage: {
          get: async <T,>(key: string) =>
            quiet(async () => {
              const r = await utils.client.modules.storageGet.query({ moduleId, key });
              queueMicrotask(stateRead);
              return r.value as T | null;
            }, null),
          set: async (key, value) => {
            await quiet(() => utils.client.modules.storageSet.mutate({ moduleId, key, value }), undefined);
          },
          delete: async key => {
            await quiet(() => utils.client.modules.storageDelete.mutate({ moduleId, key }), undefined);
          },
          update: async <T,>(key: string, change: (current: T | null) => T): Promise<T> => {
            if (disposed) return never<T>();
            let read = await utils.client.modules.storageGet.query({ moduleId, key });
            queueMicrotask(stateRead);
            // Another tab or device wrote between the read and the write: change again on theirs.
            // An update already started finishes even if the module stops meanwhile (its final flush): later writes in its chain wait on it.
            for (let tries = 0; tries < UPDATE_TRIES; tries++) {
              const next = change(read.value as T | null);
              const r = await utils.client.modules.storageSetIf.mutate({ moduleId, key, value: next, ifRevision: read.revision });
              if (!("conflict" in r)) return next;
              read = r;
            }
            throw new Error(`storage.update: "${key}" kept changing elsewhere`);
          },
        },
      };
      return {
        api,
        /** storage.update in two halves, for a framed module (its `change` runs in its frame). */
        cas: {
          read: (key: string) =>
            read(async () => {
              const r = await utils.client.modules.storageGet.query({ moduleId, key });
              queueMicrotask(stateRead);
              return r;
            }),
          setIf: (key: string, value: unknown, ifRevision: number) =>
            read(() => utils.client.modules.storageSetIf.mutate({ moduleId, key, value, ifRevision })),
        },
        dispose: () => {
          disposed = true;
          [...owned].forEach(off => off());
        },
      };
    },

    dispose() {
      unsubCache();
      unsubApp();
      clearInterval(refresh);
      themeObserver.disconnect();
      motion.removeEventListener("change", onMotion);
      unsubFocus();
      unsubScreensaver();
    },
  };
}
