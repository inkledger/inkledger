import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const SSRClock = createContext<number | null>(null);

export function SSRClockProvider({ now, children }: { now: number | null; children: ReactNode }) {
  const [initial, setInitial] = useState(now);
  useEffect(() => {
    if (initial === null) return;
    const timer = setTimeout(() => setInitial(null), 0);
    return () => clearTimeout(timer);
  }, [initial]);
  return <SSRClock.Provider value={initial}>{children}</SSRClock.Provider>;
}

// The provider and its reader form the shared SSR clock boundary.
// eslint-disable-next-line react-refresh/only-export-components
export function useSSRClock(): number | null {
  return useContext(SSRClock);
}
