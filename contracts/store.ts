import type { ModuleStatus } from "./modules";
import type { StoreItem } from "./storeSchema";

export type { StoreItem } from "./storeSchema";

/**
 * The module store: a catalog served by the store Worker (inkledger-modules/store),
 * fetched by this server only when someone opens Settings → Store. Each item's
 * `mode` drives its button: `request` (free release: ask for a licence),
 * `paid` (price, then a payment method), `soon` (shown, disabled). Licences
 * and modules come back through the Worker and are installed here as if added
 * by hand (same signature checks).
 */

export const STORE_MODES = ["request", "paid", "soon"] as const;

/** Icons a highlight may name (mapped to lucide icons in the page). */
export const STORE_ICONS = ["carrot", "sprout", "shirt", "trophy", "sun", "shield", "sparkles", "heart", "moon", "calendar"] as const;
export type StoreIcon = (typeof STORE_ICONS)[number];

export const STORE_GALLERY_MAX = 8;

/** What a module needs from the browser: where it is missing, the Store won't install it. */
export const STORE_REQUIREMENTS = ["webgl2"] as const;
export type StoreRequirement = (typeof STORE_REQUIREMENTS)[number];

export const STORE_PATH = "/api/store";

/** A licence saved as a file (Settings → Store → download / restore). */
export const LICENSE_FILE_FORMAT = "inkledger-license-v1";
export const LICENSE_FILE_EXTENSION = ".ikllicense";

/** The terms every module licence is given under (public repo). */
export const MODULE_TERMS_URL = "https://github.com/inkledger/inkledger/blob/main/docs/modules-terms.md";

export type PaymentMethod = "card" | "bitcoin";

/** A request or checkout waiting for the Worker, kept server-side until it lands. */
export type StorePending = {
  product: string;
  kind: "request" | "paid";
  status: "pending" | "declined" | "failed";
  /** Why an approved licence could not be installed (failed only). */
  reason?: string;
};

/** A catalog item as the page sees it: with what this server already has. */
/** Pictures go through this server: STORE_PATH/media/<id>/<slot>. */
export type MediaSlot = "image" | "hero" | `${number}`;
export const mediaUrl = (id: string, slot: MediaSlot) => `${STORE_PATH}/media/${id}/${slot}`;

export type StoreEntry = Omit<StoreItem, "image" | "hero" | "gallery"> & {
  image?: string;
  hero?: string;
  gallery?: { src: string; caption: { en: string; it: string } }[];
  /** The installed module's version, null when not installed. */
  installedVersion: string | null;
  /** Installed but older than the catalog: an update is available. */
  outdated: boolean;
  /** The installed module's status, null when not installed. */
  installed: ModuleStatus | null;
  /** A valid licence for the product is stored. */
  licensed: boolean;
  /** This inkledger can run the module's host API. */
  supported: boolean;
  /** A newer build exists that needs a newer inkledger (this one keeps the latest it can run). */
  needsNewerHost: boolean;
  pending: StorePending | null;
};

export type StoreBuild = NonNullable<StoreItem["builds"]>[number];

/** The newest build this inkledger can run (`runs`), and whether a newer one needs a newer host. */
export function pickBuild(item: StoreItem, runs: (b: StoreBuild) => boolean, older: (a: string, b: string) => boolean): { build: StoreBuild | null; newerElsewhere: boolean } {
  const all = item.builds ?? [{ version: item.version, hostApi: item.hostApi, slots: [], build: "" }];
  const newest = (xs: StoreBuild[]) => xs.reduce<StoreBuild | null>((a, b) => (a && !older(a.version, b.version) ? a : b), null);
  const build = newest(all.filter(runs));
  const top = newest(all);
  return { build, newerElsewhere: !!top && (!build || older(build.version, top.version)) };
}

export type StoreCatalog = { enabled: boolean; entries: StoreEntry[] };
