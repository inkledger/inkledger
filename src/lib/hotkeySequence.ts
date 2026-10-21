/**
 * "g" sequences (g d, g t, g b…) shared by every key handler: while one is
 * pending, page-level single-key shortcuts (t, b, c…) must stand aside.
 */
let pendingAt = 0;

export const hotkeySequence = {
  start() {
    pendingAt = Date.now();
  },
  clear() {
    pendingAt = 0;
  },
  /** A "g" was pressed less than a second ago. */
  pending(): boolean {
    return pendingAt > 0 && Date.now() - pendingAt < 1000;
  },
};
