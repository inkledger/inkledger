export const ROUTE_CONTROLS: Readonly<Record<string, string>> = {
  "/": "shell.nav.home",
  "/board": "shell.nav.board",
  "/pinboard": "shell.nav.pinboard",
  "/todos": "shell.nav.todos",
  "/ideas": "shell.nav.ideas",
  "/issues": "shell.nav.issues",
  "/issues/desk": "shell.nav.desk",
  "/notes": "shell.nav.notes",
  "/timesheet": "shell.nav.timesheet",
  "/reports": "shell.nav.reports",
  "/team": "shell.nav.team",
  "/settings": "shell.nav.settings",
  "/info": "shell.nav.info",
};

export function routeControlId(path: string): string | undefined {
  // The Desk is a nav entry of its own, apart from the Issues list.
  if (path.startsWith("/issues/desk")) return "shell.nav.desk";
  // The Issues list, not an issue: opening one (from search, say) is not going to the list.
  if (path === "/issues" || path.startsWith("/issues?")) return "shell.nav.issues";
  if (path.startsWith("/issues/")) return undefined;
  if (path.startsWith("/notes")) return "shell.nav.notes";
  return ROUTE_CONTROLS[path];
}

export function emitWorkspaceSearch(kind: "search.opened" | "search.selected" | "search.abandoned", path?: string): void {
  const destinationControlId = path ? routeControlId(path) : undefined;
  window.dispatchEvent(new CustomEvent("workspace:search", { detail: { kind, ...(destinationControlId ? { destinationControlId } : {}) } }));
}
