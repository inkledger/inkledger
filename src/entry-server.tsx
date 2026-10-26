import { StrictMode } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { StaticRouter } from "react-router";
import { AsyncLocalStorage } from "node:async_hooks";
import { PassThrough } from "node:stream";
import { TRPCProvider } from "@/providers/trpc";
import type { SSRTRPCContext } from "@/ssrContext";
import { SSRClockProvider } from "@/ssrClock";
import { setLocaleSource, type Locale } from "@contracts/i18n";
import App from "./App";

(globalThis as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig = { jitless: true };
const requestLocale = new AsyncLocalStorage<Locale>();
setLocaleSource(() => requestLocale.getStore());

export function renderApp(url: string, context: SSRTRPCContext, locale: Locale, now: number): Promise<string> {
  return requestLocale.run(locale, () => new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    output.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    output.on("error", reject);
    const { pipe } = renderToPipeableStream(
      <StrictMode>
        <StaticRouter location={url}>
          <SSRClockProvider now={now}>
            <TRPCProvider context={context}>
              <App />
            </TRPCProvider>
          </SSRClockProvider>
        </StaticRouter>
      </StrictMode>,
      {
        onAllReady() {
          pipe(output);
        },
        onShellError(error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        },
        onError(error) {
          console.error("[ssr]", error);
        },
      },
    );
  }));
}
