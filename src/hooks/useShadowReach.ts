import { useEffect } from "react";
import { NO_REACH, reachOf, type Reach } from "@/lib/shadowReach";

const SIDES = { l: "--surface-reach-l", r: "--surface-reach-r", t: "--surface-reach-t", b: "--surface-reach-b" } as const;

/**
 * Room for the shadows a module casts (the Shadow mod writes `--sh-1` on the
 * document): their reach per side becomes `--surface-reach-*`, which the
 * `shadow-room` containers keep free inside their clip. It follows the mod's
 * settings and its sun; without the mod nothing is written (room 0, as before).
 * Written only when it changes: a write on the document costs a frame.
 */
export function useShadowReach() {
  useEffect(() => {
    const root = document.documentElement;
    let shown: Reach = NO_REACH;
    const update = () => {
      const next = reachOf(root.style.getPropertyValue("--sh-1"));
      if ((Object.keys(SIDES) as (keyof Reach)[]).every(k => next[k] === shown[k])) return;
      shown = next;
      for (const [k, name] of Object.entries(SIDES) as [keyof Reach, string][]) {
        if (next[k] > 0) root.style.setProperty(name, `${next[k]}px`);
        else root.style.removeProperty(name);
      }
    };
    update();
    const watch = new MutationObserver(update);
    watch.observe(root, { attributes: true, attributeFilter: ["style"] });
    return () => {
      watch.disconnect();
      for (const name of Object.values(SIDES)) root.style.removeProperty(name);
    };
  }, []);
}
