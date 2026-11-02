export const ROUTE_CONTROLS: Readonly<Record<string, string>> = {
  "/": "shell.nav.home",
  "/board": "shell.nav.board",
  "/pinboard": "shell.nav.pinboard",
  "/todos": "shell.nav.todos",
  "/ideas": "shell.nav.ideas",
  "/issues": "shell.nav.issues",
  "/notes": "shell.nav.notes",
  "/timesheet": "shell.nav.timesheet",
  "/reports": "shell.nav.reports",
  "/settings": "shell.nav.settings",
  "/info": "shell.nav.info",
};

export function routeControlId(path: string): string | undefined {
  // The Desk is a nav entry of its own, with no control in the catalogue yet.
  if (path.startsWith("/issues/desk")) return undefined;
  if (path.startsWith("/issues")) return "shell.nav.issues";
  if (path.startsWith("/notes")) return "shell.nav.notes";
  return ROUTE_CONTROLS[path];
}

export function emitWorkspaceSearch(kind: "search.opened" | "search.selected" | "search.abandoned", path?: string): void {
  const destinationControlId = path ? routeControlId(path) : undefined;
  window.dispatchEvent(new CustomEvent("workspace:search", { detail: { kind, ...(destinationControlId ? { destinationControlId } : {}) } }));
}
