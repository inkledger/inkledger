import { z } from "zod";
import { STORE_GALLERY_MAX, STORE_ICONS, STORE_MODES, STORE_REQUIREMENTS, type StoreRequirement } from "./store";

const localized = z.object({ en: z.string(), it: z.string() });

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
