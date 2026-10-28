// The Outlook add-in's task pane (docs/outlook.md): a page of its own, drawn with
// the app's design system, that Outlook opens beside a mail.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { isLocale, loadLocale } from "@contracts/i18n";
import { setLocale } from "@/i18n";
import { office } from "./office";
import { OutlookPane } from "./OutlookPane";

// zod stays without its JIT here too (the CSP is the app's way of working).
(globalThis as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig = { jitless: true };

/** Light or dark as the system is (Outlook follows it too). */
function followScheme() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.classList.toggle("dark", dark.matches);
    document.documentElement.classList.toggle("light", !dark.matches);
    document.documentElement.style.colorScheme = dark.matches ? "dark" : "light";
  };
  apply();
  dark.addEventListener("change", apply);
}

/** Outlook's language, when the app speaks it. */
async function speakOutlooksLanguage(language: string | undefined) {
  const lang = (language ?? navigator.language).slice(0, 2).toLowerCase();
  if (!isLocale(lang)) return;
  await loadLocale(lang).catch(() => undefined);
  setLocale(lang);
  document.documentElement.lang = lang;
}

followScheme();
const root = createRoot(document.getElementById("root")!);
const draw = (ready: boolean) =>
  root.render(
    <StrictMode>
      <OutlookPane officeReady={ready} />
    </StrictMode>,
  );
draw(false);
const o = office();
if (o) o.onReady(() => void speakOutlooksLanguage(o.context.displayLanguage).then(() => draw(true)));
