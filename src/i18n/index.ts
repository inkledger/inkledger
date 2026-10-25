import { readStored, writeStored } from "@/lib/storage";
import { useSyncExternalStore } from "react";
import { currentLocale, INTL_TAG, isLocale, loadLocale, setLocaleSource, type Locale } from "@contracts/i18n";
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
  const saved = readStored(KEY);
  return isLocale(saved) ? saved : undefined;
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
  // Its texts first (fetched once, when not in the bundle): never a page half in English.
  void loadLocale(next)
    .catch(() => undefined)
    .then(() => apply(next));
}

function apply(next: Locale): void {
  if (next === currentLocale()) return;
  chosen = next;
  // No storage: this tab only.
  writeStored(KEY, next);
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
