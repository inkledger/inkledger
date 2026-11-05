import type { ReactNode } from "react";
import { useIssueDrop } from "@/hooks/useIssueDrop";
import { refOf, useDeskContext } from "@/hooks/useOpenBeside";
import { t } from "@/i18n";

/** The sidebar's Desk entry, a place to drop an issue dragged from a list or the board: it joins the desk. */
export function DeskDropTarget({ children }: { children: ReactNode }) {
  const context = useDeskContext();
  const { over, drop } = useIssueDrop(issue => void import("@/lib/desk/send").then(m => m.addToDesk(context.current, refOf(issue))));
  return (
    <div
      data-desk-drop={over ? "over" : undefined}
      title={over ? t("pages.desk.dropToAdd") : undefined}
      {...drop}
      // Over it with an issue: the entry outlined, like a field taking the focus.
      className="rounded-md data-[desk-drop=over]:ring-2 data-[desk-drop=over]:ring-inset data-[desk-drop=over]:ring-ring"
    >
      {children}
    </div>
  );
}
