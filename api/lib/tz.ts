/**
 * Day/week boundaries are computed in the process local time zone, which is
 * the system's: TZ when set (environment or .env), else the OS zone. In
 * Docker the container sees the host zone through the mounted /etc/timezone
 * and /etc/localtime (see docker-compose.yml). Imported first by the entry
 * module and by env.ts, so it runs before anything creates a Date.
 */
// .env first: an explicit TZ there still wins.
import "dotenv/config";
import { readFileSync } from "node:fs";

if (!process.env.TZ) {
  try {
    const zone = readFileSync("/etc/timezone", "utf8").trim();
    if (zone) process.env.TZ = zone;
  } catch {
    // No /etc/timezone (macOS, Windows): the runtime reads the OS zone itself.
  }
}

const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (process.env.TZ && resolved !== process.env.TZ) {
  console.warn(
    `[tz] resolved time zone ${resolved} differs from TZ=${process.env.TZ}: day/week boundaries may be off`,
  );
}
if (resolved === "UTC" || resolved === "Etc/UTC") {
  console.warn("[tz] the system time zone is UTC: is the host zone reaching the process?");
}
