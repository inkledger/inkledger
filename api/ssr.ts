import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { appRouter } from "./router";
import { parseCookies, renewIfHalfSpent, userFromRequest, type TrpcContext } from "./context";
import { trpc } from "../src/lib/trpc";
import type { SSRTRPCContext } from "../src/ssrContext";
import { isLocale, type Locale } from "@contracts/i18n";
import { dayKey } from "@contracts/time";
import { withLocale } from "./lib/i18n";
import { sessionCookie } from "./lib/session";
import { prefetchSSR, supportsSSR } from "./ssrQueries";

function localeOf(req: Request): Locale {
  const cookie = parseCookies(req.headers.get("cookie"))["ikl-locale"];
  if (isLocale(cookie)) return cookie;
  return "en";
}

export function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function render(url: string, context: SSRTRPCContext, locale: Locale, now: number): Promise<string> {
  const entry = path.resolve(process.cwd(), "dist/ssr/entry-server.js");
  const { renderApp } = await import(pathToFileURL(entry).href) as { renderApp: typeof render };
  return renderApp(url, context, locale, now);
}

type SSRContext = Pick<Context<{ Bindings: HttpBindings }>, "req" | "header" | "redirect" | "html">;

const localLayoutScript = `(function(){try{var local=localStorage.getItem("ikl-sidebar-collapsed")==="1"||localStorage.getItem("inkledger-modules-off")==="1"||localStorage.getItem("ikl-first-tracker-skipped")==="1";for(var i=0;i<localStorage.length;i++){var key=localStorage.key(i);if(key&&key.indexOf("ikl.timerNote.")===0)local=true}if(local)document.getElementById("root").replaceChildren()}catch(e){}})()`;

export async function renderSSR(c: SSRContext, indexHtml: string, contentSecurityPolicy: (html: string) => string): Promise<Response | null> {
  const url = new URL(c.req.url);
  if (!supportsSSR(url)) return null;
  const locale = localeOf(c.req.raw);
  return withLocale(locale, async () => {
    const now = Date.now();
    const resHeaders = new Headers();
    const { user, sessionId, expiresAt, cookie } = await userFromRequest(c.req.raw);
    const ctx: TrpcContext = { req: c.req.raw, resHeaders, user, sessionId };
    let renewed = false;
    if (user && sessionId && cookie && expiresAt) {
      renewed = (await renewIfHalfSpent({ req: c.req.raw, resHeaders }, sessionId, cookie, expiresAt)) !== null;
    }
    if (cookie && expiresAt && !renewed) {
      resHeaders.append("Set-Cookie", sessionCookie(c.req.raw, cookie, Math.max(0, Math.floor((expiresAt.getTime() - now) / 1000))));
    }
    if (url.pathname === "/" && !ctx.user) return c.redirect("/login");
    if (url.pathname === "/login" && ctx.user) return c.redirect("/");

    const helpers = createServerSideHelpers({ router: appRouter, ctx, transformer: superjson });
    await prefetchSSR(helpers, url, Boolean(ctx.user?.mustChangePassword));
    const context = {
      queryClient: helpers.queryClient,
      trpcClient: trpc.createClient({
        links: [httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
          fetch() {
            throw new Error("Unexpected tRPC fetch during SSR");
          },
        })],
      }),
    };
    const app = await render(`${url.pathname}${url.search}`, context, locale, now);
    if (sessionId && cookie) {
      const current = await userFromRequest(c.req.raw);
      if (!current.user || current.sessionId !== sessionId) return c.redirect("/login");
    }
    const payload = jsonForHtml({ state: helpers.dehydrate(), locale, day: dayKey(new Date(now)), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now });
    const layout = url.pathname === "/" ? `<script>${localLayoutScript}</script>` : "";
    const html = indexHtml
      .replace(/<html lang="[^"]*">/, `<html lang="${locale}">`)
      .replace('<div id="root"></div>', `<div id="root">${app}</div>${layout}<script id="inkledger-ssr-state" type="application/json">${payload}</script>`);
    resHeaders.forEach((value, key) => c.header(key, value));
    c.header("Cache-Control", "private, no-store");
    c.header("Content-Security-Policy", contentSecurityPolicy(html));
    return c.html(html);
  });
}
