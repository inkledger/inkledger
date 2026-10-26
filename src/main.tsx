import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./index.css";
import { TRPCProvider } from "@/providers/trpc";
import App from "./App.tsx";
import { installNativeShell, isNative } from "@/lib/native";
import { isPartFailure } from "@/components/app/lazyPart";
import { currentLocale, LOCALES, loadLocale } from "@contracts/i18n";

// zod without its JIT in the page: it would probe `new Function` (an eval the CSP blocks and
// reports). Set before any chunk with zod loads (none is in the first load); validation is the same.
(globalThis as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig = { jitless: true };

// After a redeploy, lazy chunks of the old build are gone (404): reload to
// pick up the new index.html. At most once every 10 s, so a chunk that is
// really broken cannot loop; past that, the ErrorBoundary takes over.
const PRELOAD_RELOAD_KEY = "ikl-preload-reload";
window.addEventListener("vite:preloadError", event => {
  const failure: unknown = (event as Event & { payload?: unknown }).payload;
  // Decided once the import has settled (after its promise callbacks): a dialog's part
  // claims its own failure, which shows in the dialog; anything else reloads the page.
  setTimeout(() => {
    if (isPartFailure(failure)) return;
    try {
      const last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY)) || 0;
      if (Date.now() - last < 10_000) return;
      sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now()));
    } catch {
      return; // no storage: no loop guard, so never auto-reload
    }
    window.location.reload();
  }, 0);
});

installNativeShell();

// The chosen language's texts before the first paint (English is in the bundle; another one
// comes on demand), then the others while idle (a name in another language is recognized).
void loadLocale(currentLocale())
  .catch(() => undefined)
  .finally(() => {
    render();
    const rest = () => LOCALES.forEach(l => void loadLocale(l).catch(() => undefined));
    if ("requestIdleCallback" in window) window.requestIdleCallback(rest);
    else setTimeout(rest, 2000);
  });

const render = () => createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <TRPCProvider>
        <App />
      </TRPCProvider>
    </BrowserRouter>
  </StrictMode>
);

// Installable app (PWA). Only in production: the dev server must stay uncached.
// Not in the native app: its window loads the server live, no offline shell.
if (import.meta.env.PROD && !isNative() && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
