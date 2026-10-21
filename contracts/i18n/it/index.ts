import type { Shape } from "../core";
import type { en } from "../en";
import { common } from "./common";
import { time } from "./time";
import { pages } from "./pages";
import { views } from "./views";
import { ui } from "./ui";
import { server } from "./server";
import { settings } from "./settings";

export const it: Shape<typeof en> = { common, time, pages, views, ui, server, settings };
