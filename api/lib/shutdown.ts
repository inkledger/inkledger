/**
 * Set once SIGTERM/SIGINT arrives: no new Jira sync starts, so none can still
 * be writing when the database closes.
 */
let shuttingDown = false;

export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function resetShutdownForTests(): void {
  shuttingDown = false;
}
