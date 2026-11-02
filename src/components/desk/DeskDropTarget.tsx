import { useState, type ReactNode } from "react";
import { ISSUE_DRAG_TYPE, readIssueDragData } from "@/lib/issues";
import { refOf, useDeskContext } from "@/hooks/useOpenBeside";
import { t } from "@/i18n";

/** The sidebar's Desk entry, a place to drop an issue dragged from a list or the board: it joins the desk. */
export function DeskDropTarget({ children }: { children: ReactNode }) {
  const context = useDeskContext();
  const [over, setOver] = useState(false);
  return (
    <div
      data-desk-drop={over ? "over" : undefined}
      title={over ? t("pages.desk.dropToAdd") : undefined}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes(ISSUE_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={e => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOver(false);
      }}
      onDrop={e => {
        setOver(false);
        const issue = readIssueDragData(e.dataTransfer);
        if (!issue) return;
        e.preventDefault();
        void import("@/lib/desk/send").then(m => m.addToDesk(context.current, refOf(issue)));
      }}
      // Over it with an issue: the entry outlined, like a field taking the focus.
      className="rounded-md data-[desk-drop=over]:ring-2 data-[desk-drop=over]:ring-inset data-[desk-drop=over]:ring-ring"
    >
      {children}
    </div>
  );
}
