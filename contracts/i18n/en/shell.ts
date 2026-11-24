import { common } from "./common";
import { time } from "./time";
import { pages } from "./pages";
import { views } from "./views";
import { ui } from "./ui";
import { moduleSheet, notifications, permissions } from "./settingsShell";
import { pinboard } from "./serverShell";

/**
 * The English the page's first load carries: everything but the settings' and the server's
 * texts (less the few of those the shell draws: notifications, shortcut permissions, a module's
 * sheet, a board's default name) and the texts only on-demand code says (the *Rest files). The rest comes in its own chunk, fetched at start
 * (contracts/i18n/client.ts); the server and the tests have all of English at once.
 */
export const enShell = { common, time, pages, views, ui, settings: { notifications, permissions, store: { moduleSheet } }, server: { pinboard } };
