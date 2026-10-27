// The host API v1: what a module's mount() receives. Modules are built against
// a copy of this file (inkledger-modules syncs it); change it only with a new version.
import type { SlotId } from "@contracts/modules";

export type { SlotId };

/** Subscribe; the callback gets the latest value at once, then every change. */
export type Sub<T> = (fn: (value: T) => void) => () => void;

export type TimerState = {
  state: "idle" | "running" | "paused";
  issueKey: string | null;
};

export type TodayState = {
  loggedSeconds: number;
  goalSeconds: number | null;
  /** Inside today's working hours (work schedule). */
  workTime: boolean;
};

export type ThemeState = {
  mode: "light" | "dark";
  reducedMotion: boolean;
  /** Resolved CSS colors of the design tokens. */
  /** CSS colours; `ring` is the focus outline colour. */
  tokens: Record<"primary" | "foreground" | "muted" | "card" | "border" | "background" | "ring", string>;
  /** The person wants night on the Dashboard (Settings → Appearance). Optional: older hosts don't say. */
  night?: boolean;
};

/**
 * The interface's surfaces, as the host describes them (whether or not any
 * module draws on them). Every element that may take an effect is marked by
 * the host's typed helper with `data-surface="<kind>"` and, for those that
 * stand out, `data-elev="1|2|3"` (how high above what it stands on).
 * Optional markers: `data-surface-role` ("wrap": casts for a face that clips;
 * "face": the visible top of a wrap), `data-surface-edge="off"` (no lit top
 * edge), `data-surface-current` (counts only while aria-current="page").
 */
export type SurfaceShape = "rect" | "pill" | "alpha";
export type SurfaceEffect = "cast" | "contact" | "edge";
export type SurfaceProfile = {
  /** What it is, in a few words. */
  about: string;
  /** May cast a shadow on what it stands on. */
  cast: boolean;
  /** Highest elevation allowed (0: never stands out). */
  maxElevation: 0 | 1 | 2 | 3;
  /** Its outline: a box (rounded or not), a pill, or a picture's own silhouette (alpha). */
  shape: SurfaceShape;
  /** Effects that make sense on it. */
  effects: readonly SurfaceEffect[];
  /** See-through by design: never a cast shadow under it (it would show through as a box). */
  translucent: boolean;
  /** Its picture already carries a shadow: no second one. */
  bakedShadow: boolean;
  /** Floats over the page in its own layer (menus, dialogs), outside the panel. */
  floating: boolean;
  /** How much a change of light costs it: how big it is and how many there are. */
  cost: "low" | "medium" | "high";
};
/** The catalog: every kind of surface the host marks, by name. */
export type SurfaceCatalog = Readonly<Record<string, SurfaceProfile>>;

/** Which issue, unambiguously: its key on its connection (two trackers may share a key). */
export type IssueRef = { connectionId: number; key: string };

export type HostEvents = {
  "timer-started": { issueKey: string; ref?: IssueRef };
  /** The timer stopped (`seconds` tracked on it so far, before logging). */
  "timer-stopped": { issueKey: string; seconds: number; ref?: IssueRef };
  /** A card moved between Board columns. */
  "issue-moved": { issueKey: string; from: string; to: string; ref?: IssueRef };
  /** Moved to a done status. Rank 0 is the highest priority, null when unknown. */
  "issue-closed": { issueKey: string; priorityRank: number | null; ref?: IssueRef };
  /** Time was logged (a new worklog of `seconds`, never 0). */
  "worklog-logged": { seconds: number; ref?: IssueRef };
  /** A worklog was changed or deleted: `seconds` is how much the logged time moved (negative when it shrank). */
  "worklog-changed": { seconds: number; ref?: IssueRef };
  "goal-reached": Record<string, never>;
  "focus-mode": { on: boolean };
  /** Opened or closed; a scene subscribed after activation gets the current state once. */
  screensaver: { on: boolean };
  route: { pathname: string };
};
export type HostEventName = keyof HostEvents;

export type HostWeather = {
  condition: "clear" | "cloudy" | "rain" | "snow" | "fog" | "storm";
  tempC: number;
  isDay: boolean;
  /** 0–100 */
  cloudCover: number;
  /** mm in the last hour */
  precipitation: number;
};
export type HostPlace = { name: string; country: string; lat: number; lon: number };

/**
 * A light over the Dashboard (a module's sun): shadows of cards and controls
 * lean with it and a faint veil comes in from its side. The host clamps the
 * values and drops the light when the module that set it stops.
 */
export type Ambient = {
  /** Where shadows fall per unit of their depth: x right, y down (no light: 0, 1). */
  x: number;
  y: number;
  /** Shadow strength, 1 = the theme's (0.4–1.6). */
  strength: number;
  /** Side the light comes from: -1 left edge … 1 right edge, 0 from above. */
  from: number;
  /** The veil's colour, sRGB 0–255, and opacity (at most 0.14). */
  tint: [number, number, number];
  veil: number;
  /**
   * How dark the hour is: 0 by day … 1 a night with no moon. Optional:
   * without it no night is drawn. The host dims the Dashboard with it (unless
   * the person turned night off) and softens the shadows.
   */
  dim?: number;
};

export type HostApiV1 = {
  version: 1;
  moduleId: string;
  /**
   * The slot this mount draws in. In "mobile-dock", set `el.dataset.docked`
   * on the box while a control is shown (and delete it when hidden): the page
   * then keeps its last row clear of the control.
   */
  slot: SlotId;
  locale: "en" | "it";
  timer: Sub<TimerState>;
  today: Sub<TodayState>;
  theme: Sub<ThemeState>;
  /**
   * Hours this user logged since the module started counting for them: its
   * first run after install (so progress starts from zero), 0 for data older
   * than this rule, or the date in an imported progress file. `since` is that
   * moment in epoch ms. `weekLoggedSeconds` covers this week (from Monday,
   * or from `since` when later).
   */
  totals(): Promise<{ lifetimeLoggedSeconds: number; weekLoggedSeconds: number; since: number }>;
  /**
   * The hours logged each day (the user's local day, YYYY-MM-DD), from
   * `since` (epoch ms) on but never before `totals().since`; days with
   * nothing logged are left out. Optional, like `ambient`.
   */
  history?: { daily(since?: number): Promise<{ date: string; seconds: number }[]> };
  /**
   * The weather now near a place, fetched by the inkledger server (Open-Meteo,
   * cached 30 minutes; only coordinates rounded to 0.1° leave the server).
   * null when the server has it off or the service does not answer.
   */
  weather(at: { lat: number; lon: number }): Promise<HostWeather | null>;
  /** Places matching a name, for a location setting ([] when off). */
  geocode(query: string): Promise<HostPlace[]>;
  on<E extends HostEventName>(event: E, fn: (detail: HostEvents[E]) => void): () => void;
  /**
   * @deprecated Since the Shadow module: the host draws no light of its own any
   * more and ignores this (kept so modules built before still load).
   */
  ambient?(light: Ambient | null): void;
  /** The catalog of surfaces (see SurfaceCatalog). Optional: older hosts don't have it. */
  surfaces?: { catalog(): SurfaceCatalog };
  /**
   * Where the interface lives: `root`, the app shell holding every surface
   * (menus and dialogs float outside it, in the document); `panel`, the main
   * panel, or null. Optional: older hosts don't have it.
   */
  stage?: { root(): HTMLElement | null; panel(): HTMLElement | null };
  /** Opens this module's settings (its `settings` slot) in a sheet over the page. Optional, like `ambient`. */
  openSettings?(): void;
  /**
   * Makes the shape drawn in `el` clickable, and only the shape. In the slots
   * drawn over the page ("dashboard-perch", "dashboard-overlay") everything
   * a module adds stays `pointer-events: none`, so the page under it keeps
   * working; a gesture that starts where `test` is true (x, y from `el`'s top
   * left in CSS px, and its size) is the module's, and ends in `activate`.
   * `el` also becomes focusable (Enter/Space activate). Returns the undo.
   * Whatever a module draws in those slots stays inside their box and under
   * the page's sticky header: no z-index of its own can lift it out.
   * Optional, like `ambient`: without it, nothing of the module is clickable there.
   */
  hitArea?(el: HTMLElement, test: (x: number, y: number, width: number, height: number) => boolean, activate: () => void): () => void;
  /**
   * A per-user cache of pictures on the inkledger server (webp, png or avif, up to
   * 512 KB each), shared by the user's devices. The host keeps it small: the
   * least recently used go past 48 files or 8 MB, unread ones after 30 days,
   * all of them on uninstall. Optional, like `ambient`.
   */
  files?: {
    get(key: string): Promise<Blob | null>;
    put(key: string, file: Blob): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** Per user and module, JSON values up to 16 KB, 64 keys. */
  storage: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    /**
     * Changes a value from the latest one saved, as one step across tabs and devices: `change`
     * gets the saved value (null if none) and returns the new one; when another tab or device
     * wrote meanwhile, `change` runs again on what they wrote. Keep it pure (it may run more
     * than once) and idempotent per event (say, a set of event ids already counted). Resolves
     * with the value saved. Optional: hosts before it lack it (use `set` there).
     */
    update?<T>(key: string, change: (current: T | null) => T): Promise<T>;
  };
};

/** A module's default export. */
export type InkledgerModuleV1 = {
  id: string;
  hostApi: 1;
  mount: Partial<Record<SlotId, (el: HTMLElement, host: HostApiV1) => () => void>>;
};
