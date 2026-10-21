import { createContext } from "react";

/** The text typed in "Search settings": matching groups light up and open. */
export const SettingsSearch = createContext("");

/** Lower-cased, accents removed: "café" matches "cafe". */
export const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

export function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const q = normalize(query.trim());
  return q !== "" && texts.some(t => t && normalize(t).includes(q));
}
