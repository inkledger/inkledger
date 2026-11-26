import { useAuth } from "@/hooks/useAuth";

/**
 * What this account does in the Store (the server checks it again): manage it (licences,
 * installs, removal), acquire modules (the whole catalogue, request or buy), or neither:
 * only the modules granted to it, to turn on or off and set up.
 */
export function useStoreAccess(): { manage: boolean; acquire: boolean } {
  const held = useAuth().user?.permissions ?? [];
  return { manage: held.includes("manageStore"), acquire: held.includes("acquireModules") };
}
