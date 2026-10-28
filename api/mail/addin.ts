// The Outlook add-in "Pin to inkledger" (docs/outlook.md): a button in the
// mail reading pane opens a small task pane served from here, which reads the
// open mail's headers through Office.js (ReadItem: no Graph, no admin) and pins
// it to an issue, a new TODO or the pinboard. Outlook loads add-ins only over
// HTTPS (scripts/outlook-https.mjs on the local network). The pane runs inside
// Outlook, where inkledger's session cookie is not sent: it calls these routes
// with the add-in key (Settings → Outlook), which opens them and nothing else.
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { mailAddinKeys, settings, users, type User } from "@db/schema";
import { appRouter } from "../router";
import { addinKeyHash } from "../routers/mails";
import { withLocale } from "../lib/i18n";
import { t } from "@contracts/i18n";

const BASE = "/api/outlook";
/** The pane: a page of the app's build (outlook.html, src/outlook/), drawn with its design system. */
const PANE = "/outlook.html";
/** The add-in's id: one add-in, whatever server it points at (a mailbox installs one). */
const ADDIN_ID = "6d3f1c2e-8a4b-4f7e-9c1d-2b5e7a9f0c31";

/** Where Outlook shows add-ins in a frame (on the web; the apps embed them without one). */
const OUTLOOK_FRAMES = [
  "https://outlook.office.com",
  "https://outlook.office365.com",
  "https://outlook.cloud.microsoft",
  "https://outlook.live.com",
  "https://*.officeapps.live.com",
];
/**
 * Office.js loads more of itself from Microsoft's hosts (which ones vary by
 * client), may evaluate code and start blob workers, and talks to Outlook:
 * the pane allows any https source for that. It shows only text (never markup
 * from the server or a mail), and its key lives in Outlook, not in a cookie.
 */
const PANE_CSP = [
  "default-src 'self' https:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: https:",
  "font-src 'self' data: https:",
  `frame-ancestors 'self' ${OUTLOOK_FRAMES.join(" ")}`,
].join("; ");

/** Registered before secureHeaders: the pane may be framed by Outlook (and only by it). */
export const outlookFrames: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.path === PANE) {
    c.res.headers.delete("X-Frame-Options");
    // Outlook's own page opens the pane: isolating it from that page would cut Office.js off.
    c.res.headers.delete("Cross-Origin-Opener-Policy");
    c.res.headers.set("Content-Security-Policy", PANE_CSP);
  }
  if (c.req.path.startsWith(`${BASE}/`)) c.res.headers.delete("Cross-Origin-Resource-Policy");
};

const escapeXml = (s: string) => s.replace(/[<>&"']/g, ch => `&#${ch.charCodeAt(0)};`);

/** The server's own address as Outlook reaches it (behind the HTTPS proxy: its host, https). */
function originOf(c: Context): string {
  const host = c.req.header("host") ?? new URL(c.req.url).host;
  return `https://${host}`;
}

export function manifestXml(origin: string): string {
  const o = escapeXml(origin);
  const en = (k: "button" | "buttonTip") => escapeXml(withLocale("en", () => t(`server.outlook.${k}`)));
  const it = (k: "button" | "buttonTip") => escapeXml(withLocale("it", () => t(`server.outlook.${k}`)));
  const icon = `${o}/icon-192.png`;
  // 1.1 (Mailbox 1.5) lets the pane stay open and follow the mail selected; older clients read 1.0.
  const overrides = (minVersion: string, pinnable: boolean) => `    <Requirements><bt:Sets DefaultMinVersion="${minVersion}"><bt:Set Name="Mailbox"/></bt:Sets></Requirements>
    <Hosts>
      <Host xsi:type="MailHost">
        <DesktopFormFactor>
          <ExtensionPoint xsi:type="MessageReadCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="inkledgerGroup">
                <Label resid="Group.Label"/>
                <Control xsi:type="Button" id="inkledgerPin">
                  <Label resid="Pin.Label"/>
                  <Supertip><Title resid="Pin.Label"/><Description resid="Pin.Tip"/></Supertip>
                  <Icon><bt:Image size="16" resid="Icon"/><bt:Image size="32" resid="Icon"/><bt:Image size="80" resid="Icon"/></Icon>
                  <Action xsi:type="ShowTaskpane"><SourceLocation resid="Pane.Url"/>${pinnable ? "<SupportsPinning>true</SupportsPinning>" : ""}</Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images><bt:Image id="Icon" DefaultValue="${icon}"/></bt:Images>
      <bt:Urls><bt:Url id="Pane.Url" DefaultValue="${o}/outlook.html"/></bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Group.Label" DefaultValue="inkledger"/>
        <bt:String id="Pin.Label" DefaultValue="${en("button")}"><bt:Override Locale="it-IT" Value="${it("button")}"/></bt:String>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Pin.Tip" DefaultValue="${en("buttonTip")}"><bt:Override Locale="it-IT" Value="${it("buttonTip")}"/></bt:String>
      </bt:LongStrings>
    </Resources>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0" xmlns:mailappor="http://schemas.microsoft.com/office/mailappversionoverrides/1.0" xsi:type="MailApp">
  <Id>${ADDIN_ID}</Id>
  <Version>1.1.0.0</Version>
  <ProviderName>inkledger</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="inkledger"/>
  <Description DefaultValue="${en("buttonTip")}"><Override Locale="it-IT" Value="${it("buttonTip")}"/></Description>
  <IconUrl DefaultValue="${icon}"/>
  <HighResolutionIconUrl DefaultValue="${icon}"/>
  <SupportUrl DefaultValue="${o}/"/>
  <AppDomains><AppDomain>${o}</AppDomain></AppDomains>
  <Hosts><Host Name="Mailbox"/></Hosts>
  <Requirements><Sets><Set Name="Mailbox" MinVersion="1.1"/></Sets></Requirements>
  <FormSettings>
    <Form xsi:type="ItemRead">
      <DesktopSettings><SourceLocation DefaultValue="${o}/outlook.html"/><RequestedHeight>360</RequestedHeight></DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or"><Rule xsi:type="ItemIs" ItemType="Message" FormType="Read"/></Rule>
  <DisableEntityHighlighting>false</DisableEntityHighlighting>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
${overrides("1.3", false)}
    <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides/1.1" xsi:type="VersionOverridesV1_1">
${overrides("1.5", true)}
    </VersionOverrides>
  </VersionOverrides>
</OfficeApp>
`;
}

/** The key's owner, if the key is valid (its use noted). */
async function keyUser(c: Context): Promise<User | null> {
  const key = c.req.header("authorization")?.match(/^Bearer (ikl_ol_[\w-]{20,})$/)?.[1];
  if (!key) return null;
  const db = getDb();
  const [row] = await db
    .select({ id: mailAddinKeys.id, user: users })
    .from(mailAddinKeys)
    .innerJoin(users, eq(users.id, mailAddinKeys.userId))
    .where(and(eq(mailAddinKeys.keyHash, addinKeyHash(key)), isNull(users.disabledAt)));
  if (!row || row.user.mustChangePassword) return null;
  await db.update(mailAddinKeys).set({ lastUsedAt: new Date() }).where(eq(mailAddinKeys.id, row.id));
  return row.user;
}

/** Runs the procedures the add-in may use, as the key's owner. */
async function asKeyOwner(c: Context, run: (caller: ReturnType<typeof appRouter.createCaller>, user: User) => Promise<unknown>): Promise<Response> {
  const user = await keyUser(c);
  if (!user) return c.json({ error: t("server.mails.badKey") }, 401);
  const caller = appRouter.createCaller({ req: c.req.raw, resHeaders: new Headers(), user, sessionId: null });
  try {
    return c.json({ ok: true, data: await run(caller, user) });
  } catch (e) {
    if (!(e instanceof TRPCError)) throw e;
    return c.json({ error: e.message }, getHTTPStatusCodeFromError(e) as 400);
  }
}

export function registerOutlookRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  app.get(`${BASE}/manifest.xml`, c =>
    c.body(manifestXml(originOf(c)), 200, {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="inkledger-outlook.xml"',
    }),
  );
  // Add-ins installed from the first manifest open the pane here.
  app.get(`${BASE}/taskpane.html`, c => c.redirect(PANE, 302));

  /** The key works; the pane takes the user's theme colour. */
  app.get(`${BASE}/me`, c =>
    asKeyOwner(c, async (_caller, user) => {
      const [s] = await getDb().select({ themeColor: settings.themeColor }).from(settings).where(eq(settings.userId, user.id));
      return { themeColor: s?.themeColor ?? "#B5562F" };
    }),
  );
  app.get(`${BASE}/issues`, c =>
    asKeyOwner(c, async caller => {
      const q = (c.req.query("q") ?? "").trim().slice(0, 200);
      const r = await caller.issues.list({ search: q, includeDone: !!q, includeUnassigned: !!q, pageSize: 8 });
      return r.issues.map(i => ({ key: i.key, summary: i.summary, connectionId: i.connectionId }));
    }),
  );
  app.get(`${BASE}/places`, c =>
    asKeyOwner(c, caller => caller.mails.placesOf({ internetMessageId: c.req.query("messageId") || null, exchangeId: c.req.query("exchangeId") || null })),
  );
  app.get(`${BASE}/boards`, c =>
    asKeyOwner(c, async caller => (await caller.pinboard.boards()).filter(b => !b.follow).map(b => ({ id: b.id, name: b.name }))),
  );
  app.post(`${BASE}/save`, async c => {
    const body: unknown = await c.req.json().catch(() => null);
    return asKeyOwner(c, caller => caller.mails.save(body as Parameters<typeof caller.mails.save>[0]));
  });
  app.post(`${BASE}/pin`, async c => {
    const body: unknown = await c.req.json().catch(() => null);
    return asKeyOwner(c, caller => caller.mails.pinTo(body as Parameters<typeof caller.mails.pinTo>[0]));
  });
}
