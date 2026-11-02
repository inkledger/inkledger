import { useEffect, useState } from "react";

/** Whether the media query matches, followed live; `initial` until mounted (the first paint's guess). */
export function useMediaQuery(query: string, initial: boolean): boolean {
  const [matches, setMatches] = useState(initial);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}
