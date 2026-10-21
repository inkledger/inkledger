import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { CANVAS_H, CANVAS_W } from "@contracts/pinboard";
import { pinboardLive } from "@/lib/pinboardLive";
import { threads } from "@/lib/pinboardString";

type Hung = Parameters<typeof threads>[0][number];

/**
 * The red strings of a board: from each hung private note to its issue, pin
 * to pin. The threads run under the paper (the notes stay readable), the pin
 * heads sit on top, so each thread looks tied to its pins. Decorative (the
 * notes say whose they are). It follows a dragged post-it through
 * pinboardLive, so a drag redraws these SVGs only; at rest it does nothing.
 */
export function Strings({ notes }: { notes: Hung[] }) {
  const live = useSyncExternalStore(pinboardLive.subscribe, pinboardLive.get);
  const ts = useMemo(() => threads(notes, live), [notes, live]);
  if (ts.length === 0) return null;
  const layer = (z: number, children: ReactNode, attr: Record<string, string>) => (
    <svg aria-hidden className="pointer-events-none absolute left-0 top-0" width={CANVAS_W} height={CANVAS_H} style={{ zIndex: z }} {...attr}>
      {children}
    </svg>
  );
  return (
    <>
      {layer(
        -1,
        ts.map(t => (
          <g key={t.id} data-string={t.id}>
            <path className="pin-string-shadow" d={t.d} transform="translate(0 2)" />
            <path className="pin-string" d={t.d} />
          </g>
        )),
        { "data-pinboard-strings": "" }
      )}
      {layer(
        1_000_000,
        ts.flatMap(t =>
          [t.from, t.to].map((p, i) => (
            <g key={`${t.id}-${i}`}>
              <circle className="pin-head" cx={p.x} cy={p.y} r={5.5} />
              <circle className="pin-shine" cx={p.x - 1.6} cy={p.y - 1.8} r={1.6} />
            </g>
          ))
        ),
        { "data-pinboard-pins": "" }
      )}
    </>
  );
}
