import type { DehydratedState } from "@tanstack/react-query";
import superjson, { type SuperJSONResult } from "superjson";
import type { Locale } from "@contracts/i18n";

export type SSRPayload = {
  state: SuperJSONResult;
  locale: Locale;
  day: string;
  timeZone: string;
  now: number;
};

export function readSSRState() {
  const element = document.getElementById("inkledger-ssr-state");
  if (!element?.textContent) return null;
  const text = element.textContent;
  element.remove();
  // A state that doesn't read leaves the app to fetch its data, rather than not start at all.
  try {
    const payload = JSON.parse(text) as SSRPayload;
    return { dehydratedState: superjson.deserialize<DehydratedState>(payload.state), locale: payload.locale, day: payload.day, timeZone: payload.timeZone, now: payload.now };
  } catch (e) {
    console.warn("[ssr] state unreadable, starting without it", e);
    return null;
  }
}
