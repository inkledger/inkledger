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
};

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
   * Light the Dashboard (null: back to the theme's). Optional: hosts before it
   * don't have it, so check before calling. One light at a time: the last call wins.
   */
  ambient?(light: Ambient | null): void;
  /** Opens this module's settings (its `settings` slot) in a sheet over the page. Optional, like `ambient`. */
  openSettings?(): void;
  /**
   * Makes the shape drawn in `el` clickable, and only the shape. In the slots
   * drawn over the page ("dashboard-perch", "dashboard-overlay") everything
   * a module adds stays `pointer-events: none`, so the page under it keeps
   * working; a gesture that starts where `test` is true (x, y from `el`'s top
   * left in CSS px, and its size) is the module's, and ends in `activate`.
   * `el` also becomes focusable (Enter/Space activate). Returns the undo.
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
  };
};

/** A module's default export. */
export type InkledgerModuleV1 = {
  id: string;
  hostApi: 1;
  mount: Partial<Record<SlotId, (el: HTMLElement, host: HostApiV1) => () => void>>;
};
