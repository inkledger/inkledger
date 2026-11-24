import { common } from "./common";
import { time } from "./time";
import { pages } from "./pages";
import { pagesRest } from "./pagesRest";
import { views } from "./views";
import { viewsRest } from "./viewsRest";
import { ui } from "./ui";
import { uiRest } from "./uiRest";
import { server } from "./server";
import { settings } from "./settings";

/** English: the reference dictionary (every key starts here). */
export const en = {
  common,
  time,
  pages: { ...pages, ...pagesRest },
  views: { ...views, ...viewsRest },
  ui: { ...ui, ...uiRest },
  server,
  settings,
};
