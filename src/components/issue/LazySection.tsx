import { useRef } from "react";
import { useShownOnce } from "@/hooks/useShownOnce";

/**
 * A heavy section (comments, mails, attachments) that mounts, and so reads, only once it
 * nears the screen, then stays. Not `lazy` (the issue page): its children as they are.
 */
export function LazySection({ lazy, children }: { lazy: boolean; children: React.ReactNode }) {
  if (!lazy) return children;
  return <Deferred>{children}</Deferred>;
}

function Deferred({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useShownOnce(ref, true, "200px");
  if (shown) return children;
  // Room for the section while it waits, so the pane's scroll height doesn't jump much.
  return <div ref={ref} aria-hidden className="min-h-24" />;
}
