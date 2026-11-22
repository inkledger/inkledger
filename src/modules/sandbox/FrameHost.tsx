import { useEffect, useLayoutEffect, useRef } from "react";
import type { ModuleListEntry } from "@contracts/modules";
import type { ViewSlot } from "../hostV2";
import type { Hub } from "../host";
import { mountView } from "./frames";

/** A framed module's box in a slot: its view frame fills it. */
export function FramedBox({ hub, entry, slot, className }: { hub: Hub; entry: ModuleListEntry; slot: ViewSlot; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest entry, without remaking the frame when the list is fetched again (a fresh token, same package).
  const latest = useRef(entry);
  useEffect(() => {
    latest.current = entry;
  });
  const { id, frameUrl } = entry;
  // A layout effect: its cleanup runs while the frame is still in the page, so the module's own cleanup can run.
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || !frameUrl) return;
    return mountView(hub, latest.current, slot, box);
  }, [hub, id, frameUrl, slot]);
  return <div ref={ref} data-module={id} className={className} />;
}
