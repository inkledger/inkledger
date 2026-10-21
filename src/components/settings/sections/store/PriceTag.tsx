import type { StoreEntry } from "@contracts/store";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatPrice, priceLabel, type Locale } from "./format";

/**
 * What a module costs: during the free preview its future price crossed out
 * beside "Free during the preview"; otherwise the plain label.
 */
export function PriceTag({ entry: e, locale, className }: { entry: StoreEntry; locale: Locale; className?: string }) {
  if (e.mode !== "request" || !e.price) return <span className={className}>{priceLabel(e, locale)}</span>;
  const price = formatPrice(e, locale);
  return (
    <span className={cn("inline-flex flex-wrap items-baseline gap-x-2", className)}>
      <s className="text-muted-foreground decoration-1" aria-label={t("settings.store.priceAfter", { price })}>
        {price}
      </s>
      <span>{t("settings.store.freePreview")}</span>
    </span>
  );
}
