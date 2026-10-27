/**
 * The screensaver's frame loop: at most `fps` frames a second, none while the page is
 * hidden; `frame` gets the time since the last one (capped, so a long pause is no jump).
 */
export function runLoop(fps: number, frame: (dtSeconds: number, nowMs: number) => void): () => void {
  const every = 1000 / fps;
  let raf = 0;
  let last = 0;
  let stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (last === 0) last = now - every;
    const gap = now - last;
    // A little slack: a 60 Hz screen asking for 30 fps draws every other frame, not drifting.
    if (gap < every - 2) return;
    last = now;
    frame(Math.min(gap, 100) / 1000, now);
  };
  const onVisibility = () => {
    cancelAnimationFrame(raf);
    if (document.hidden) return;
    last = 0;
    raf = requestAnimationFrame(tick);
  };
  document.addEventListener("visibilitychange", onVisibility);
  if (!document.hidden) raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Device pixels per CSS pixel for a full-screen canvas: sharp, but never more than ~3.5 M pixels. */
export function canvasScale(width: number, height: number, dpr: number): number {
  const area = Math.max(1, width * height);
  return Math.max(0.5, Math.min(dpr, 1.5, Math.sqrt(3_500_000 / area)));
}
