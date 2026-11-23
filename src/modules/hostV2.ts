// The host API v2: what a framed module gets. Its code runs in a sandboxed
// frame (opaque origin) and reaches the host only through messages, so every
// member is asynchronous or a subscription, and anything outside the module's
// box is a capability declared in its signed manifest.
import type { ModuleCapability } from "@contracts/modules";
import type { HostApiV1, SlotId, Sub, ThemeState } from "./types";

export type { ModuleCapability };

/**
 * Where a v2 module draws: the v1 slots, plus a sheet the host owns (dialog, focus, Esc) and
 * "page-overlay" ("page.overlay"): the whole window, over the page and the sidebar but under
 * the page's banners, headers and dialogs, on every page; it never takes pointer events.
 */
export type ViewSlot = SlotId | "sheet" | "page-overlay";

/** How a hit area was activated: a click (x, y from the box's top left, CSS px), or Enter/Space on its host box. */
export type HitActivation = { via: "pointer"; x: number; y: number } | { via: "keyboard" };

/** A clickable part of an overlay, in CSS px from the box's top left. */
export type HitRegion =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "circle"; x: number; y: number; r: number };

/**
 * A hit area's keyboard side: a focusable button of the host's, and its accessible name.
 * `onFocus`: that button took or lost the focus (`visible`: the keyboard's, as :focus-visible).
 */
export type HitOptions = { label?: string; focusable?: boolean; onFocus?(focused: boolean, visible: boolean): void };

/** How much a module may spend: "reduce" draws less often, "still" keeps a still picture. */
export type BudgetLevel = "normal" | "reduce" | "still";

export type ThemeStateV2 = ThemeState & {
  /** How dark the hour is on the Dashboard (0 day … 1 night), in place of reading `--sky-dim`. */
  skyDim?: number;
};

/**
 * `docked`: a module shows a control on the phone's tab bar (the page keeps its last row clear).
 * `viewport`: the window's size in CSS px (a frame's own media queries measure the frame).
 * `navMore`: the sidebar's scroller has more below what shows. `scrolling`: the page is
 * scrolling now (false once it has been still a moment).
 */
export type LayoutState = {
  sidebar: "full" | "rail";
  docked: boolean;
  viewport?: { width: number; height: number };
  navMore?: boolean;
  scrolling?: boolean;
};

/** The top edge of a card or section header in sight, in CSS px from the box's top left (y: the edge). */
export type Ledge = { x: number; y: number; w: number };

/** The pointer relative to the slot box, coalesced per frame; null while away. */
export type PointerState = { x: number; y: number } | null;

/** A rectangle in CSS px from the box's top left (it may lie past the box). */
export type BoxRect = { x: number; y: number; w: number; h: number };

/**
 * One of the app's landmarks in sight: where it is, never what it holds. A board column says
 * only its place (index, left to right) and its status category, never its name.
 */
export type Anchor = BoxRect &
  (
    | { kind: "timer" | "log-time" | "notifications" | "search" | "sidebar" }
    | { kind: "board-column"; index: number; category: "todo" | "doing" | "done" | null }
  );

/**
 * Something the person just did, where it shows (rects in the box's px, null when out of sight):
 * a card moved between board columns, a ticket closed, the timer started or stopped (the timer's
 * control), a notification arrived (the bell), a search field took or lost the focus, the day's
 * goal reached. Never which ticket, column or text.
 */
export type PageEvent =
  | { kind: "card-moved"; from: BoxRect | null; to: BoxRect | null; card: BoxRect | null }
  | { kind: "card-closed"; card: BoxRect | null }
  | { kind: "timer-started" | "timer-stopped"; at: BoxRect | null }
  | { kind: "notification"; at: BoxRect | null }
  | { kind: "search"; focused: boolean; at: BoxRect | null }
  | { kind: "goal-reached" }
  /**
   * The page is changing under the overlay (another route, the sidebar folding, the window
   * resizing): "pending" as it starts, "ready" once the new page has settled (ask ledges and
   * anchors again then). The overlay itself stays: it is never remounted by a navigation.
   */
  | { kind: "transition"; phase: "pending" | "ready" };

/** The basics every framed module gets (no capability needed). */
type Basics = Omit<HostApiV1, "version" | "slot" | "theme" | "stage" | "ambient" | "hitArea" | "storage"> & {
  version: 2;
  theme: Sub<ThemeStateV2>;
  budget: Sub<BudgetLevel>;
  /**
   * The page moved under the frame: a scroll, a resize, a route change, the
   * sidebar folding, a sheet opening or closing, the main region's content
   * changing (elements added or removed; text alone never counts). Told once things settle
   * (in an animation frame), never per scroll event. Returns the undo.
   */
  layoutChanged?(fn: () => void): () => void;
  /**
   * As in v1; `update` runs `change` in the frame over a read and a conditional write.
   * Writes keep the host's pace: a burst on one key coalesces (sets and deletes: the
   * latest wins; updates: their changes applied in order over one write), never refused.
   */
  storage: Required<HostApiV1["storage"]>;
  /**
   * Short strings kept for this tab's session (a reload keeps them, signing in
   * or out drops them): what happens once a session. Keys up to 64 characters, values
   * up to 4096, 32 keys.
   */
  session?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
};

/** Members present only when the manifest declares their capability (and the host offers it). */
type Capabilities = {
  /**
   * "surfaces.light": allowlisted shadow variables, strict values; null drops the light.
   * `off`: surface kinds of the catalog left unlit. About one cast a frame reaches the
   * page, the latest winning; it rejects when the host refused it (a value, a kind).
   */
  surfaces?: HostApiV1["surfaces"] & { light?(vars: Readonly<Record<string, string>> | null, off?: readonly string[]): Promise<void> };
  /** "page.importance" (a view's): how much each point of the box matters (password fields always 1, a point past the box 1); four calls a second for the whole module. */
  page?: { importance(points: readonly (readonly [number, number])[]): Promise<(0 | 0.8 | 1)[]> };
  /**
   * "page.ledges" (a view's): the top edges of the cards and section headers in sight inside
   * the box with clear room above them, top to bottom, where something drawn may stand; rects
   * only, a few dozen at most, four calls a second.
   */
  ledges?(): Promise<Ledge[]>;
  /** "pointer" (a view's): null while the pointer is more than 160 px from the box. */
  pointer?: Sub<PointerState>;
  /** "pointer.page" (a view's): the pointer anywhere in the window, in the box's px; null while it is out of the window, the page hidden or the box out of sight. */
  pagePointer?: Sub<PointerState>;
  /** "page.anchors" (a view's): the app's landmarks in sight (a few dozen at most, four calls a second); ask again on layoutChanged. */
  anchors?(): Promise<Anchor[]>;
  /** "page.events" (a view's): what the person does, with where it shows (eight a second at most). Returns the undo. */
  pageEvents?(fn: (e: PageEvent) => void): () => void;
  /**
   * "sheet": opens (on the person's gesture in this view, never from the runtime) or closes this module's sheet slot. Open, its frame takes the focus and Esc
   * in it closes it; closed, the focus goes back to the opening view's box (its host button,
   * else its frame).
   */
  sheet?: { open(): void; close(): void };
  /** "share", "download", "open-image": brokered, need the person's gesture in this view (a click, or a key once they put the focus there) in the last five seconds. */
  share?(file: Blob, name: string): Promise<boolean>;
  download?(file: Blob, name: string): Promise<void>;
  /**
   * "download.large": saves a film (WebM or MP4, as MediaRecorder makes it) or a picture of up to
   * 64 MB, sent as a Blob (never copied), two in a row then one every ten seconds. The same gesture
   * rule as "download": call it from the person's click that saves it, with the file already made
   * (a recording finished first, then a "Save" button), not at the end of a long recording.
   */
  downloadLarge?(file: Blob, name: string): Promise<void>;
  openImage?(file: Blob): Promise<void>;
  /** "geo": where the person is, right after their gesture in this view; null when refused. */
  geo?: { here(): Promise<{ lat: number; lon: number } | null> };
  /** "cache": a local per-module cache the host owns. */
  cache?: {
    get(key: string): Promise<Blob | null>;
    put(key: string, value: Blob): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** "dock": in "mobile-dock", whether a control shows (the page keeps its last row clear). */
  dock?: { set(docked: boolean): void };
  /** "backdrop.preblurred": the picture carries its own blur, the host adds none. */
  backdrop?: {
    preblurred(on: boolean): void;
    /** The blur (px) the host would add: a picture that bakes it in draws it itself. */
    blur: Sub<number>;
  };
  /**
   * "layout". `navFade` (in "sidebar-footer"): the host draws its fade over the nav's lower
   * edge, above the box, while the nav has more below; false takes it away.
   */
  layout?: Sub<LayoutState> & { navFade?: (on: boolean) => void };
};

/** What a view (one slot mount) gets. */
export type HostApiV2 = Basics &
  Capabilities & {
    slot: ViewSlot;
    /**
     * Makes these regions of an overlay clickable ("dashboard-overlay",
     * "dashboard-perch", "panel-edge", "mobile-dock"): the frame itself never takes
     * pointer events there; the host tests a gesture against the regions and calls
     * `activate`. [] clears. In "mobile-dock" the frame has room past the box
     * (16 px, 8 px on the right) for the pill's shadow, shown once a shape is set.
     * A picture instead: its alpha over the whole box is the shape (sent at most
     * 512 px a side; ten changes a second at most). A shape over more of the box than
     * a quarter (or 256 × 256 px in a small one) is ignored: no catch-all over the page.
     * `opts.focusable`: the host's box takes Tab and Enter/Space as a button named
     * `opts.label`; without it the host adds no Tab stop (the frame's own control
     * takes the keyboard). `activate` hears how: a click (where, in the box) or the keyboard.
     */
    hit: { set(shape: readonly HitRegion[] | ImageBitmap, activate: (how?: HitActivation) => void, opts?: HitOptions): void };
    /** In "mobile-more" only: closes the phone's More sheet (e.g. as the module's own sheet opens). */
    more?: { close(): void };
    /** In "dashboard-widget" only: true takes the card off the page (the Desk shows no empty card); the frame runs on. */
    hidden?(on: boolean): void;
    /** "runtime": a port to this module's runtime (one per view); absent when the host made none. */
    runtime?: MessagePort;
    /**
     * "runtime": `fn` runs once the runtime is gone (it failed, or was never
     * made: then at once); its port is closed, the view falls back on its own.
     * Returns the undo.
     */
    runtimeGone?(fn: () => void): () => void;
  };

/** What the module's runtime gets: one per module, as long as it runs, holding what its views share. */
export type RuntimeHost = Basics &
  Capabilities & {
    /** Each view as it mounts: its port and slot. Returns the undo. */
    views(fn: (port: MessagePort, slot: ViewSlot) => void): () => void;
  };

/**
 * What a mount or the runtime hands back: run as its frame goes (a slot unmounted, the
 * module switched off or uninstalled, the page going). A promise (saves in flight) is
 * waited for up to a second; as the page goes nothing is waited for.
 */
export type Cleanup = () => void | Promise<void>;

/** A framed module's default export. */
export type InkledgerModuleV2 = {
  id: string;
  hostApi: 2;
  /** Runs once in the module's runtime frame ("runtime" capability); returns its cleanup, run after its views'. */
  runtime?(host: RuntimeHost): Cleanup;
  mount: Partial<Record<ViewSlot, (el: HTMLElement, host: HostApiV2) => Cleanup>>;
};

/** Which capability unlocks each optional member. */
export const CAPABILITY_OF = {
  runtime: "runtime",
  "surfaces.light": "surfaces.light",
  page: "page.importance",
  ledges: "page.ledges",
  pointer: "pointer",
  pagePointer: "pointer.page",
  anchors: "page.anchors",
  pageEvents: "page.events",
  sheet: "sheet",
  share: "share",
  download: "download",
  downloadLarge: "download.large",
  openImage: "open-image",
  geo: "geo",
  cache: "cache",
  dock: "dock",
  backdrop: "backdrop.preblurred",
  layout: "layout",
} as const satisfies Record<string, ModuleCapability>;
