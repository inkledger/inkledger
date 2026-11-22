// The host API v2: what a framed module gets. Its code runs in a sandboxed
// frame (opaque origin) and reaches the host only through messages, so every
// member is asynchronous or a subscription, and anything outside the module's
// box is a capability declared in its signed manifest.
import type { ModuleCapability } from "@contracts/modules";
import type { HostApiV1, SlotId, Sub, ThemeState } from "./types";

export type { ModuleCapability };

/** Where a v2 module draws: the v1 slots, plus a sheet the host owns (dialog, focus, Esc). */
export type ViewSlot = SlotId | "sheet";

/** A clickable part of an overlay, in CSS px from the box's top left. */
export type HitRegion =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "circle"; x: number; y: number; r: number };

/** A hit area's keyboard side: a focusable button of the host's, and its accessible name. */
export type HitOptions = { label?: string; focusable?: boolean };

/** How much a module may spend: "reduce" draws less often, "still" keeps a still picture. */
export type BudgetLevel = "normal" | "reduce" | "still";

export type ThemeStateV2 = ThemeState & {
  /** How dark the hour is on the Dashboard (0 day … 1 night), in place of reading `--sky-dim`. */
  skyDim?: number;
};

/** `docked`: a module shows a control on the phone's tab bar (the page keeps its last row clear). */
export type LayoutState = { sidebar: "full" | "rail"; docked: boolean };

/** The pointer relative to the slot box, coalesced per frame; null while away. */
export type PointerState = { x: number; y: number } | null;

/** The basics every framed module gets (no capability needed). */
type Basics = Omit<HostApiV1, "version" | "slot" | "theme" | "stage" | "ambient" | "hitArea" | "storage"> & {
  version: 2;
  theme: Sub<ThemeStateV2>;
  budget: Sub<BudgetLevel>;
  /**
   * The page moved under the frame: a scroll, a resize, a route change, the
   * sidebar folding, a sheet opening or closing. Told once things settle
   * (in an animation frame), never per scroll event. Returns the undo.
   */
  layoutChanged?(fn: () => void): () => void;
  /** As in v1; `update` runs `change` in the frame over a read and a conditional write. */
  storage: Required<HostApiV1["storage"]>;
  /**
   * Short strings kept for this tab's session (a reload keeps them, signing out
   * drops them): what happens once a session. Keys up to 64 characters, values
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
  /** "page.importance": how much each point of the page matters (password fields are always 1). */
  page?: { importance(points: readonly (readonly [number, number])[]): Promise<(0 | 0.8 | 1)[]> };
  /** "pointer" */
  pointer?: Sub<PointerState>;
  /** "sheet": opens or closes this module's sheet slot. */
  sheet?: { open(): void; close(): void };
  /** "share", "download", "open-image": brokered, need the person's gesture. */
  share?(file: Blob, name: string): Promise<boolean>;
  download?(file: Blob, name: string): Promise<void>;
  openImage?(file: Blob): Promise<void>;
  /** "geo": where the person is, after their gesture; null when refused. */
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
  /** "layout" */
  layout?: Sub<LayoutState>;
};

/** What a view (one slot mount) gets. */
export type HostApiV2 = Basics &
  Capabilities & {
    slot: ViewSlot;
    /**
     * Makes these regions of an overlay clickable ("dashboard-overlay",
     * "dashboard-perch"): the frame itself never takes pointer events there; the
     * host tests a gesture against the regions and calls `activate`. [] clears.
     * A picture instead: its alpha over the whole box is the shape (sent at most
     * 512 px a side; ten changes a second at most).
     * `opts.focusable`: the host's box takes Tab and Enter/Space as a button named
     * `opts.label`; without it the host adds no Tab stop (the frame's own control
     * takes the keyboard).
     */
    hit: { set(shape: readonly HitRegion[] | ImageBitmap, activate: () => void, opts?: HitOptions): void };
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

/** A framed module's default export. */
export type InkledgerModuleV2 = {
  id: string;
  hostApi: 2;
  /** Runs once in the module's runtime frame ("runtime" capability); returns its cleanup. */
  runtime?(host: RuntimeHost): () => void;
  mount: Partial<Record<ViewSlot, (el: HTMLElement, host: HostApiV2) => () => void>>;
};

/** Which capability unlocks each optional member. */
export const CAPABILITY_OF = {
  runtime: "runtime",
  "surfaces.light": "surfaces.light",
  page: "page.importance",
  pointer: "pointer",
  sheet: "sheet",
  share: "share",
  download: "download",
  openImage: "open-image",
  geo: "geo",
  cache: "cache",
  dock: "dock",
  backdrop: "backdrop.preblurred",
  layout: "layout",
} as const satisfies Record<string, ModuleCapability>;
