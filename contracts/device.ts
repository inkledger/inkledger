/**
 * A device as the user would name it, from its User-Agent: "Chrome · macOS",
 * "inkledger app · Android" (`native`: the page knows it runs in the app).
 * Shared: the page names itself, the server falls back to the header. Only
 * shown to the same user, on the timer it labels.
 */
export function deviceLabel(ua: string | null | undefined, native = false): string {
  const s = ua ?? "";
  const os = /iPhone/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /Mac OS X|Macintosh/.test(s)
          ? "macOS"
          : /Windows/.test(s)
            ? "Windows"
            : /Linux|X11/.test(s)
              ? "Linux"
              : "";
  const app = native
    ? "inkledger app"
    : /Edg\//.test(s)
      ? "Edge"
      : /Firefox\//.test(s)
        ? "Firefox"
        : /OPR\//.test(s)
          ? "Opera"
          : /Chrome\//.test(s)
            ? "Chrome"
            : /Safari\//.test(s)
              ? "Safari"
              : "";
  return [app, os].filter(Boolean).join(" · ");
}
