import { APP_BUILD_META } from "@contracts/appBuild";

/**
 * The service worker's address for this page's build. The browser installs a worker again only when its
 * bytes or its address change, and sw.js is the same file in every build: named by the build, each new one
 * installs, so its offline page and cache cleanup follow the build instead of the first one installed.
 */
export function serviceWorkerUrl(build: string | null): string {
  return build ? `/sw.js?build=${encodeURIComponent(build)}` : "/sw.js";
}

/** The build this page was served from (written in it at build time), or null (development). */
export function pageBuild(): string | null {
  return typeof document === "undefined" ? null : (document.querySelector<HTMLMetaElement>(`meta[name="${APP_BUILD_META}"]`)?.content ?? null);
}
