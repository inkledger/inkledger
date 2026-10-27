import { deviceSetting } from "@/lib/storage";

/** The scene chosen in Settings (per device): a built-in id or "mod:<id>". */
export const screensaverScene = deviceSetting<string>("ikl-screensaver-scene", raw => raw ?? "ink");

/** Whether the clock, the timer and today's hours show over the scene (per device). */
export const screensaverOverlay = deviceSetting<boolean>("ikl-screensaver-overlay", raw => raw !== "0", v => (v ? "1" : "0"));
