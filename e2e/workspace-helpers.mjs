// The Workspace page's controls that sit behind a step: More (footer), History (a sheet), usage
// collection (a dialog). Shared by the workspace and FlowMap e2e files.

/** Picks `item` (a name or a pattern) from the footer's More menu. */
export async function workspaceMore(page, item) {
  await page.getByRole("button", { name: "More options", exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: typeof item === "string" }).click();
}

/** Opens the usage collection dialog and returns its switch ("Collect interaction maps"). */
export async function collectionSwitch(page) {
  await workspaceMore(page, /^Usage collection/);
  return page.getByRole("dialog", { name: "Usage collection" }).getByRole("checkbox", { name: "Collect interaction maps" });
}

/** Saves the usage so far as a period (was "Update evidence"), and waits until it is said done. */
export async function updatePeriods(page) {
  await workspaceMore(page, "Update usage periods");
  await page.locator("[data-status-slot]").getByText("Usage periods updated.", { exact: true }).waitFor();
}

/** Opens the History sheet and returns its list (#workspace-history). */
export async function openHistory(page) {
  await page.locator("[data-workspace-footer]").getByRole("button", { name: "History", exact: true }).click();
  const history = page.locator("#workspace-history");
  await history.waitFor();
  return history;
}

/** Opens Suggestions (or "Compare two periods") in its sheet and returns its content (#workspace-planner). */
export async function openPlanner(page, item = "Suggestions") {
  await workspaceMore(page, item);
  const planner = page.locator("#workspace-planner");
  await planner.waitFor();
  return planner;
}

/** Closes the sheet or dialog on top, back to the page. */
export async function closeOverlay(page) {
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
}

/** A layer's chip on the Layout toolbar ("Edit", "Use", "Paths", "Friction"). */
export const layerChip = (page, name) => page.getByRole("toolbar", { name: "Layers" }).getByRole("button", { name, exact: true });
