/**
 * The window listeners of one pointer's drag: its moves, its release (`finish(true)`), its cancel and
 * Escape (`finish(false)`). Other pointers are ignored. Escape is taken in the capture phase so a
 * dialog under the drag does not also close; `escape.when` limits it to while the drag is on, and
 * `escape.stop` also keeps other Escape listeners from seeing it. Returns the remover.
 */
export function listenPointerSession(
  pointerId: number,
  on: {
    move: (e: PointerEvent) => void;
    finish: (drop: boolean) => void;
    escape?: { when?: () => boolean; stop?: boolean };
  },
): () => void {
  const move = (e: PointerEvent) => {
    if (e.pointerId === pointerId) on.move(e);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId === pointerId) on.finish(true);
  };
  const cancel = (e: PointerEvent) => {
    if (e.pointerId === pointerId) on.finish(false);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || (on.escape?.when && !on.escape.when())) return;
    e.preventDefault();
    if (on.escape?.stop) e.stopPropagation();
    on.finish(false);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
  return () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
  };
}
