import type { ReactNode } from "react";
import { EmptyState } from "@/components/app/States";
import { LayoutMiniature } from "@/components/desk/LayoutPicker";
import { PALETTE_SHORTCUT } from "@/lib/dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { t } from "@/i18n";

/** The arrangements a desk can take, as the empty desk's picture. */
function Arrangements() {
  return (
    <span aria-hidden className="mb-2 flex items-center gap-3 text-muted-foreground">
      <LayoutMiniature preset="cols-2" />
      <LayoutMiniature preset="main-left" />
      <LayoutMiniature preset="quad" />
    </span>
  );
}

/** A phone or a touch screen: no keyboard shortcut to point at. */
const TOUCH = "(pointer: coarse), (max-width: 1023px)";

/** Nothing on the desk yet: what it is for, "Add issue", and the other ways in. */
export function DeskEmpty({ add }: { add: ReactNode }) {
  const touch = useMediaQuery(TOUCH, typeof window !== "undefined" && window.matchMedia(TOUCH).matches);
  return (
    <EmptyState
      icon={Arrangements}
      title={t("pages.desk.emptyTitle")}
      message={
        <>
          {t("pages.desk.emptyMessage")}
          <br />
          {touch ? t("pages.desk.emptyWaysTouch") : t("pages.desk.emptyWays", { shortcut: PALETTE_SHORTCUT })}
        </>
      }
      action={add}
      className="py-20"
    />
  );
}
