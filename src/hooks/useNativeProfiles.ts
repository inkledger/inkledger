import { useCallback, useEffect, useState } from "react";
import { isNative, listProfiles, type ServerProfiles } from "@/lib/native";

/** The native app's server profiles (null in the browser or until loaded). */
export function useNativeProfiles(): { profiles: ServerProfiles | null; reload: () => void } {
  const [profiles, setProfiles] = useState<ServerProfiles | null>(null);
  const reload = useCallback(() => {
    if (isNative()) void listProfiles().then(p => setProfiles(p ?? null));
  }, []);
  useEffect(reload, [reload]);
  return { profiles, reload };
}

/** The profile this window shows: the one whose server is this origin. */
export function currentProfileUrl(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}
