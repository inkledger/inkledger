/** How long after opening keys and clicks are swallowed: the press that opened it must not close it. */
export const GRACE_MS = 500;

/** What a key does on the screensaver: ← / → switch scene, any other closes it. */
export function screensaverKey(key: string, sinceOpenMs: number): "prev" | "next" | "ignore" | "close" {
  if (key === "ArrowLeft") return "prev";
  if (key === "ArrowRight") return "next";
  if (sinceOpenMs < GRACE_MS) return "ignore";
  return "close";
}
