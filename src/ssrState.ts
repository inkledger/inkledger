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
  const payload = JSON.parse(text) as SSRPayload;
  return { dehydratedState: superjson.deserialize<DehydratedState>(payload.state), locale: payload.locale, day: payload.day, timeZone: payload.timeZone, now: payload.now };
}
