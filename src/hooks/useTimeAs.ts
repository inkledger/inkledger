import { useState } from "react";
import { settleTimeAs, switchTimeAs, type Pin, type Shown, type TimeAs } from "@/lib/timeAs";

/**
 * A new entry's time as a duration or an end time (src/lib/timeAs.ts), the
 * same in every log form. `pinStart`: the form's start, fixed for an end;
 * `toDuration`: back to a duration, the length the end made.
 */
export function useTimeAs(on: { pinStart: (start: string) => void; toDuration: (seconds: number) => void }) {
  const [mode, setMode] = useState<TimeAs>("duration");
  const [end, setEnd] = useState("");
  const [pending, setPending] = useState<number | null>(null);
  const pin = (p: Pin) => {
    setPending(null);
    on.pinStart(p.start);
    setEnd(p.end);
  };
  return {
    mode,
    end,
    setEnd,
    /** The length an end asked for before the start was placed will have. */
    pending,
    switchTo(next: TimeAs, shown: Shown, parsed: number | null) {
      const s = switchTimeAs(mode, next, shown, parsed);
      if (!s) return;
      if (s.pin) pin(s.pin);
      else setPending(s.pending);
      if (s.duration) on.toDuration(s.duration);
      setMode(s.mode);
    },
    /** Called while rendering: an end waiting for the start pins once it is shown. */
    settle(byEnd: boolean, shown: Shown) {
      const p = settleTimeAs(pending, byEnd, shown);
      if (p) pin(p);
    },
    reset() {
      setMode("duration");
      setEnd("");
      setPending(null);
    },
  };
}
