import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./index.css";
import { TRPCProvider } from "@/providers/trpc";
import App from "./App.tsx";
import { installNativeShell, isNative } from "@/lib/native";
import { prefetchingParts } from "@/components/app/lazyPart";

// After a redeploy, lazy chunks of the old build are gone (404): reload to
// pick up the new index.html. At most once every 10 s, so a chunk that is
// really broken cannot loop; past that, the ErrorBoundary takes over.
const PRELOAD_RELOAD_KEY = "ikl-preload-reload";
window.addEventListener("vite:preloadError", event => {
  // A dialog's code fetched ahead of use: its failure shows where it opens, no reload now.
  if (prefetchingParts()) return;
  try {
    const last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY)) || 0;
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now()));
  } catch {
    return; // no storage: no loop guard, so never auto-reload
  }
  event.preventDefault(); // handled: don't rethrow the import error
  window.location.reload();
});

installNativeShell();

createRoot(document.getElementById("root")!).render(
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
