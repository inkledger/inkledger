import { deviceSetting } from "@/lib/storage";

const collapsed = deviceSetting("ikl-sidebar-collapsed", raw => raw === "1", v => (v ? "1" : "0"));

/** Desktop sidebar collapsed to an icon rail (per device). */
export const sidebar = {
  toggle: () => collapsed.set(!collapsed.get()),
  /** Outside React (framed modules' layout). */
  collapsed: collapsed.get,
  subscribe: collapsed.subscribe,
};

export function useSidebarCollapsed(): boolean {
  return collapsed.use();
}
