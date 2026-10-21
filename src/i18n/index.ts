import { useSyncExternalStore } from "react";
import { currentLocale, INTL_TAG, isLocale, setLocaleSource, type Locale } from "@contracts/i18n";
import { invokeNative } from "@/lib/native";

export {
  t,
  currentLocale,
  dateFormat,
  numberFormat,
  relativeFormat,
  LOCALES,
  LOCALE_NAMES,
  type Locale,
  type MessageKey,
} from "@contracts/i18n";

/**
 * The language of the app: the user's choice on this device (English until
 * one is made). Kept in localStorage, so the login page speaks it too; sent
 * to the server with every request (x-locale) for its messages.
 */
const KEY = "ikl-locale";

/** The saved choice; none yet → the default (English). */
function read(): Locale | undefined {
  try {
    const saved = localStorage.getItem(KEY);
    return isLocale(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

let chosen: Locale | undefined = read();
const listeners = new Set<() => void>();
setLocaleSource(() => chosen);

function applyToDocument() {
  if (typeof document === "undefined") return; // node tests
  document.documentElement.lang = INTL_TAG[currentLocale()].slice(0, 2);
}

/** The native shell (menus, tray, profiles page) speaks the same language. */
function tellNativeShell() {
  void invokeNative("set_locale", { locale: currentLocale() }).catch(() => undefined);
}

applyToDocument();
// After the imports have settled (native.ts may import this module too).
queueMicrotask(tellNativeShell);

export function getLocale(): Locale {
  return currentLocale();
}

export function setLocale(next: Locale): void {
  if (next === currentLocale()) return;
  chosen = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // no storage: this tab only
  }
  applyToDocument();
  tellNativeShell();
  listeners.forEach(l => l());
}

/** The current locale; the app root re-renders everything when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    currentLocale
  );
}
