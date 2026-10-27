/**
 * Add-on modules: closed bundles signed by the publisher, unlocked by an
 * offline licence (seal, api/vendor/seal). The server checks signature, hashes
 * and licence on every request and serves only verified bytes; the page loads
 * a module's ESM and mounts it into slots, handing it the host API below.
 * A module runs with the page's privileges: trust rests on the signature.
 */

/** The host API version modules are built against. */
export const HOST_API_VERSION = 1;

/**
 * Where modules can draw. "panel-edge" is a zero-size anchor on the bottom-left
 * corner of the main panel: whatever a module draws there floats above the
 * page and never takes room in the layout.
 */
/**
 * Where modules draw. Adding a slot is compatible (host API stays v1); an
 * older inkledger refuses a manifest naming one it does not know.
 */
export const SLOT_IDS = ["sidebar-footer", "dashboard-overlay", "panel-edge", "dashboard-widget", "dashboard-backdrop", "dashboard-action", "settings", "sidebar-rail", "mobile-more", "mobile-dock", "dashboard-perch", "app-stage", "screensaver"] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export const LICENSE_CONTEXT = "inkledger-license-v1\n";
export const PACKAGE_CONTEXT = "inkledger-package-v1\n";
export const LICENSE_VERSION = 1;
export const MANIFEST_FILE = "manifest.json";
export const SIGNATURE_FILE = "manifest.sig";
export const BUNDLE_MAX_BYTES = 2 * 1024 * 1024;

export type { LicensePayload, ModuleManifest } from "./modulesSchema";

/** Whether a manifest runs on this inkledger: its host API range and every slot it names. */
export const runsHere = (m: { hostApi: { min: number; max: number }; slots: readonly string[] }): boolean =>
  m.hostApi.min <= HOST_API_VERSION && HOST_API_VERSION <= m.hostApi.max && m.slots.every((s) => (SLOT_IDS as readonly string[]).includes(s));

export type ModuleStatus =
  | { state: "active" }
  | { state: "needs-license" }
  /** Licensed, but not active on this server (WP-19): the store counts the servers of a licence */
  | { state: "needs-activation" }
  | { state: "unsupported-host-api" }
  | { state: "invalid"; reason: string };

/** What the page sees of an installed module. */
export type ModuleListEntry = {
  id: string;
  version: string;
  product: string;
  name: { en: string; it: string };
  slots: SlotId[];
  status: ModuleStatus;
  /** Content-addressed URL of the entry, only when active. */
  entryUrl: string | null;
  /** SRI of the entry ("sha256-…"), only when active. */
  integrity: string | null;
  /** Which build this is (a rebuild keeps its version): hex of the signature's hash, 32 chars. */
  build: string | null;
};

export const MODULES_PATH = "/api/modules";
export const STORAGE_MAX_BYTES = 16 * 1024;
export const STORAGE_MAX_KEYS = 64;

/** Module files (host API files): a cache, per user and module. */
export const FILE_MAX_BYTES = 512 * 1024;
export const FILES_MAX_COUNT = 48;
export const FILES_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** Files nobody read for this long go. */
export const FILES_MAX_IDLE_MS = 30 * 86_400_000;
export const FILE_TYPES = ["image/webp", "image/png", "image/avif"] as const;

/** How much of a dashboard backdrop shows through (veil and blur, set by the host). */
export const BACKDROP_VISIBILITY = ["subtle", "normal", "scenic"] as const;
export type BackdropVisibility = (typeof BACKDROP_VISIBILITY)[number];

/** A module's saved progress as a file (exported and imported from the Store badge). */
export const PROGRESS_FILE_FORMAT = "inkledger-progress-v1";
export const PROGRESS_FILE_EXTENSION = ".iklprogress";
