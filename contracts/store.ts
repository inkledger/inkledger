import { z } from "zod";
import type { ModuleStatus } from "./modules";

/**
 * The module store: a catalog served by the store Worker (inkledger-modules/store),
 * fetched by this server only when someone opens Settings → Store. Each item's
 * `mode` drives its button: `request` (free release: ask for a licence),
 * `paid` (price, then a payment method), `soon` (shown, disabled). Licences
 * and modules come back through the Worker and are installed here as if added
 * by hand (same signature checks).
 */

const localized = z.object({ en: z.string(), it: z.string() });

export const STORE_MODES = ["request", "paid", "soon"] as const;
export type StoreMode = (typeof STORE_MODES)[number];

/** Icons a highlight may name (mapped to lucide icons in the page). */
export const STORE_ICONS = ["carrot", "sprout", "shirt", "trophy", "sun", "shield", "sparkles", "heart", "moon", "calendar"] as const;
export type StoreIcon = (typeof STORE_ICONS)[number];

export const STORE_GALLERY_MAX = 8;

/** What a module needs from the browser: where it is missing, the Store won't install it. */
export const STORE_REQUIREMENTS = ["webgl2"] as const;
export type StoreRequirement = (typeof STORE_REQUIREMENTS)[number];

export const storeItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  product: z.string().regex(/^inkledger\.[a-z0-9-]+$/),
  version: z.string(),
  hostApi: z.object({ min: z.number().int(), max: z.number().int() }),
  name: localized,
  tagline: localized,
  // An unknown future mode shows as "soon" rather than breaking the list.
  mode: z.enum(STORE_MODES).catch("soon"),
  price: z.object({ amount: z.number().nonnegative(), currency: z.string().length(3) }).optional(),
  methods: z
    .object({ card: z.boolean().default(false), bitcoin: z.enum(["on", "soon", "off"]).catch("off").default("off") })
    .default({ card: false, bitcoin: "off" }),
  docsUrl: z.url().optional(),
  /** Small square picture (list fallback). */
  image: z.url().optional(),
  /** 16:10 picture without text, on the card and atop the product page. */
  hero: z.url().optional(),
  description: z.object({ en: z.array(z.string()), it: z.array(z.string()) }).optional(),
  highlights: z
    .array(z.object({ icon: z.enum(STORE_ICONS).catch("sparkles"), title: localized, body: localized }))
    .max(6)
    .optional(),
  gallery: z.array(z.object({ src: z.url(), caption: localized })).max(STORE_GALLERY_MAX).optional(),
  badge: z.enum(["new", "beta", "free"]).optional().catch(undefined),
  /**
   * Every published build of the module, newest or not, with what it needs
   * from the host: each inkledger installs the latest one it can run, so an
   * update never breaks a module someone paid for. Missing from older stores.
   */
  builds: z
    .array(
      z.object({
        version: z.string(),
        hostApi: z.object({ min: z.number().int(), max: z.number().int() }),
        slots: z.array(z.string()),
        build: z.string(),
      }),
    )
    .optional()
    .catch(undefined),
  // Unknown future requirements are dropped (this inkledger can't check them).
  requires: z
    .array(z.string())
    .optional()
    .catch(undefined)
    .transform((xs) => xs?.filter((x): x is StoreRequirement => (STORE_REQUIREMENTS as readonly string[]).includes(x))),
});
export type StoreItem = z.infer<typeof storeItemSchema>;

export const storeCatalogSchema = z.object({
  v: z.number(),
  // Items that do not parse are dropped, not fatal.
  items: z.array(z.unknown()).transform((xs) =>
    xs.flatMap((x) => {
      const r = storeItemSchema.safeParse(x);
      return r.success ? [r.data] : [];
    }),
  ),
});

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
