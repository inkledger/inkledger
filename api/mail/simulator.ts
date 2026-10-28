// Microsoft in memory, for the browser tests (MAIL_SIMULATOR=1): the sign-in
// answers at once, and a small mailbox answers Graph's message lists with its
// shapes ({ value }, internetMessageId in "<…>", ImmutableId-style ids, webLink).
// Written from Microsoft's documentation, not recorded from a real tenant.

type SimMessage = {
  id: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  receivedDateTime: string;
  internetMessageId: string;
  webLink: string;
};

const message = (n: number, subject: string, name: string, address: string, at: string): SimMessage => {
  const id = `AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A${String(n).padStart(4, "0")}AAA=`;
  return {
    id,
    subject,
    from: { emailAddress: { name, address } },
    receivedDateTime: at,
    internetMessageId: `<sim-${n}@example.com>`,
    webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`,
  };
};

const MAILBOX: SimMessage[] = [
  message(3, "Release 2.3 sign-off", "Anna Bianchi", "anna@example.com", "2026-10-27T15:30:00Z"),
  message(2, "Budget 2027", "Giulia Rossi", "giulia@example.com", "2026-10-27T09:00:00Z"),
  message(1, "Kick-off notes", "Marco Verdi", "marco@example.com", "2026-10-26T08:15:00Z"),
];

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function simulatedMicrosoft(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  if (u.hostname === "login.microsoftonline.com") {
    const form = new URLSearchParams(typeof init.body === "string" ? init.body : "");
    if (u.pathname.endsWith("/devicecode"))
      return json({ device_code: "sim-device", user_code: "SIMCODE1", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5 });
    if (form.get("grant_type") === "refresh_token" || form.get("device_code") === "sim-device")
      return json({ access_token: "sim-access", expires_in: 3600, refresh_token: "sim-refresh", token_type: "Bearer" });
    return json({ error: "invalid_grant" }, 400);
  }
  if (new Headers(init.headers).get("Authorization") !== "Bearer sim-access") return json({ error: { code: "InvalidAuthenticationToken" } }, 401);
  if (u.pathname === "/v1.0/me") return json({ userPrincipalName: "mario.rossi@example.com", displayName: "Mario Rossi" });
  const search = u.searchParams.get("$search")?.replace(/"/g, "").trim().toLowerCase();
  const filter = u.searchParams.get("$filter")?.match(/internetMessageId eq '(.+)'/)?.[1];
  const found = MAILBOX.filter(
    m =>
      (!search || `${m.subject} ${m.from.emailAddress.name} ${m.from.emailAddress.address}`.toLowerCase().includes(search)) &&
      (!filter || m.internetMessageId === filter),
  );
  return json({ value: found });
}
