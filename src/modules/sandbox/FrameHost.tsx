import { useEffect, useRef } from "react";
import type { ModuleListEntry, SlotId } from "@contracts/modules";
import type { Hub } from "../host";
import { mountView } from "./frames";

/** A framed module's box in a slot: its view frame fills it. */
export function FramedBox({ hub, entry, slot, className }: { hub: Hub; entry: ModuleListEntry; slot: SlotId; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest entry, without remaking the frame when the list is fetched again (a fresh token, same package).
  const latest = useRef(entry);
  useEffect(() => {
    latest.current = entry;
  });
  const { id, frameUrl } = entry;
  useEffect(() => {
    const box = ref.current;
    if (!box || !frameUrl) return;
    return mountView(hub, latest.current, slot, box);
  }, [hub, id, frameUrl, slot]);
  return <div ref={ref} data-module={id} className={className} />;
}
