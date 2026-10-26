import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { pinboardFloat, pinboardFloatFocus } from "@/lib/flag";
import { floatHidden, usePinboardSurfacesNow } from "@/hooks/usePinboardPanel";
import { lazyPart } from "@/components/app/lazyPart";
import { FloatingPanel } from "@/components/app/FloatingPanel";
import { floatRectSetting, PINBOARD_SHAPE } from "@/lib/pinboardFloat";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { t } from "@/i18n";

const Pinboard = lazyPart(() => import("@/components/board/Pinboard").then(m => m.Pinboard));

const stored = floatRectSetting("ikl-pinboard-float");

/**
 * The pinboard over any page, never in the way of the page's keys: floating,
 * moved by its handle and sized from its corner (kept per device), not a
 * dialog; on small screens a sheet from the bottom. It gives way where the
 * pinboard already is (its page, the Board with its panel): mounted once.
 */
export function PinboardWidget() {
  const open = pinboardFloat.useValue();
  const { pathname } = useLocation();
  const surfaces = usePinboardSurfacesNow();
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const shown = open && surfaces.widget && !floatHidden(pathname);
  const close = () => pinboardFloat.set(false);

  if (!wide) {
    return (
      <Sheet open={shown} onOpenChange={pinboardFloat.set}>
        <SheetContent side="bottom" hideClose className="flex h-[85dvh] flex-col rounded-t-2xl p-3">
          <SheetTitle className="sr-only">{t("pages.board.pinboard")}</SheetTitle>
          <SheetDescription className="sr-only">{t("pages.board.pinboardDescription")}</SheetDescription>
          {shown && <Pinboard className="min-h-0 flex-1" resizable={false} onClose={close} />}
        </SheetContent>
      </Sheet>
    );
  }
  return shown ? (
    <FloatingPanel
      marker="pinboard"
      label={t("ui.pinboardFloat.label")}
      strings={{ move: t("ui.pinboardFloat.move"), moveHint: t("ui.pinboardFloat.moveHint"), resize: t("ui.pinboardFloat.resize"), resizeHint: t("ui.pinboardFloat.resizeHint") }}
      stored={stored}
      shape={PINBOARD_SHAPE}
      focus={pinboardFloatFocus}
      onClose={close}
    >
      <Pinboard className="min-h-0 flex-1 px-3 pb-3" resizable={false} onClose={close} />
    </FloatingPanel>
  ) : null;
}

