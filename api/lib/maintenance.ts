/**
 * Maintenance: the database is being replaced (a restore). No sync, sink pass or
 * write starts meanwhile (writes answer 503, the page says why); syncs under way
 * are waited for first. Left on when a restore failed and its safety copy couldn't
 * be brought back either: the server stays closed to writes until someone looks.
 */
let on: string | null = null;

export function enterMaintenance(reason: string): void {
  on = reason;
}

export function leaveMaintenance(): void {
  on = null;
}

export function inMaintenance(): boolean {
  return on !== null;
}

/** Why, while on. */
export function maintenanceReason(): string | null {
  return on;
}
