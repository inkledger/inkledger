import { createContext, useContext, type ReactNode } from "react";

const SSRClock = createContext<number | null>(null);

// Never changes: a new value would reach the boundaries still waiting to hydrate and hydrate them all at once.
export function SSRClockProvider({ now, children }: { now: number | null; children: ReactNode }) {
  return <SSRClock.Provider value={now}>{children}</SSRClock.Provider>;
}

// The provider and its reader form the shared SSR clock boundary.
// eslint-disable-next-line react-refresh/only-export-components
export function useSSRClock(): number | null {
  return useContext(SSRClock);
}
