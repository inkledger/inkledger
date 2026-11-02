import type { StaleDraftInfo } from "@contracts/workspace/repropose";

/** The cause of a CONFLICT on a draft made on an older layout: how much of it can be proposed again reaches the page (errorFormatter). */
export class StaleDraftError extends Error {
  readonly info: StaleDraftInfo;
  constructor(info: StaleDraftInfo) {
    super(`stale draft, ${info.keepable} kept`);
    this.info = info;
  }
}
