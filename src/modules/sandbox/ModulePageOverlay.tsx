import { useContext } from "react";
import { ModulesContext } from "../context";
import { FramedBox } from "./FrameHost";

/**
 * The framed modules drawn over the whole window ("page.overlay"), on every page: over the
 * page and the sidebar, under the page's banners, the burrow's edge, headers and dialogs
 * (z-15); while a dialog is open, over its backdrop (z-49) and under the dialog itself (z-50,
 * later in the page). Nothing in it takes the pointer: the host tests a module's shapes (hit.set).
 */
export function ModulePageOverlay() {
  const ctx = useContext(ModulesContext);
  const mine = ctx?.modules.filter(m => m.entry.frameUrl && m.entry.capabilities.includes("page.overlay")) ?? [];
  if (!ctx || mine.length === 0) return null;
  return (
    <div data-page-overlay className="pointer-events-none fixed inset-0 z-[15] [&_*]:!pointer-events-none [body:has([data-slot=dialog-overlay][data-state=open])_&]:z-50">
      {mine.map(m => (
        <FramedBox key={m.entry.id} hub={ctx.hub} entry={m.entry} slot="page-overlay" className="absolute inset-0" />
      ))}
    </div>
  );
}
