import { StrictMode } from "react";
import { StaticRouter } from "react-router";
import { AsyncLocalStorage } from "node:async_hooks";
import { TRPCProvider } from "@/providers/trpc";
import type { SSRTRPCContext } from "@/ssrContext";
import { SSRClockProvider } from "@/ssrClock";
import { renderAllReady } from "@/ssrStream";
import { setLocaleSource, type Locale } from "@contracts/i18n";
import App from "./App";

(globalThis as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig = { jitless: true };
const requestLocale = new AsyncLocalStorage<Locale>();
setLocaleSource(() => requestLocale.getStore());

export function renderApp(url: string, context: SSRTRPCContext, locale: Locale, now: number): Promise<string> {
  return requestLocale.run(locale, () =>
    renderAllReady(
      <StrictMode>
        <StaticRouter location={url}>
          <SSRClockProvider now={now}>
            <TRPCProvider context={context}>
              <App />
            </TRPCProvider>
          </SSRClockProvider>
        </StaticRouter>
      </StrictMode>,
    ),
  );
}
