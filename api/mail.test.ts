import { describe, expect, it } from "vitest";
import { decodeWords, parseAddress, parseEmlHeaders, parseOutlookUrl, restItemId } from "@contracts/mail";

const ID = "AAQkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgAQAGxqR1k8Q3FAqK/hm+o3Zr8=";
const REST = restItemId(ID);

describe("parseOutlookUrl", () => {
  it("reads a message opened in a folder, on every Outlook web host", () => {
    for (const host of ["outlook.office.com", "outlook.cloud.microsoft", "outlook.live.com"]) {
      const r = parseOutlookUrl(`https://${host}/mail/inbox/id/${encodeURIComponent(ID)}`);
      expect(r).toEqual({ itemId: REST, webLink: `https://${host}/mail/deeplink/read/${encodeURIComponent(REST)}` });
    }
  });

  it("reads deeper folder paths and numbered mailboxes", () => {
    expect(parseOutlookUrl(`https://outlook.office.com/mail/0/sentitems/id/${encodeURIComponent(ID)}`)?.itemId).toBe(REST);
    expect(parseOutlookUrl(`https://outlook.office.com/mail/id/${encodeURIComponent(ID)}`)?.itemId).toBe(REST);
  });

  it("reads deeplinks, with ids encoded once or twice", () => {
    const once = encodeURIComponent(ID);
    expect(parseOutlookUrl(`https://outlook.office.com/mail/deeplink/read/${once}?ItemID=x&exvsurl=1`)?.itemId).toBe(REST);
    expect(parseOutlookUrl(`https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(once)}`)?.itemId).toBe(REST);
  });

  it("turns the legacy /owa link into a link on outlook.office.com", () => {
    const r = parseOutlookUrl(`https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(ID)}&exvsurl=1&viewmodel=ReadMessageItem`);
    expect(r).toEqual({ itemId: REST, webLink: `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(REST)}` });
  });

  it("refuses other hosts, plain http, folders and junk", () => {
    expect(parseOutlookUrl(`https://evil.example/mail/inbox/id/${ID}`)).toBeNull();
    expect(parseOutlookUrl(`http://outlook.office.com/mail/inbox/id/${ID}`)).toBeNull();
    expect(parseOutlookUrl("https://outlook.office.com/mail/inbox")).toBeNull();
    expect(parseOutlookUrl("https://outlook.office.com/mail/inbox/id/short")).toBeNull();
    expect(parseOutlookUrl("not a url")).toBeNull();
  });
});

describe("parseEmlHeaders", () => {
  const eml = [
    "Received: from mx.example (mx.example [192.0.2.1])",
    "\tby mail.example; Tue, 27 Oct 2026 09:59:00 +0100",
    "From: =?UTF-8?Q?Gi=C3=B9lia_Rossi?= <Giulia.Rossi@Example.com>",
    "To: team@example.com",
    "Subject: =?UTF-8?B?UmU6IFJpbGFzY2lvIOKAkyB2ZXJzaW9uZQ==?=",
    " =?UTF-8?B?IDIuMw==?=",
    "Date: Tue, 27 Oct 2026 10:00:00 +0100",
    "Message-ID: <CAF12345@mail.example.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Subject: this is the body, never read",
  ].join("\r\n");

  it("reads subject, sender, date and Message-ID, decoding and unfolding", () => {
    expect(parseEmlHeaders(eml)).toEqual({
      subject: "Re: Rilascio – versione 2.3",
      fromName: "Giùlia Rossi",
      fromAddress: "giulia.rossi@example.com",
      receivedAt: Date.parse("2026-10-27T09:00:00Z"),
      internetMessageId: "CAF12345@mail.example.com",
    });
  });

  it("keeps what is there when headers are missing", () => {
    expect(parseEmlHeaders("Subject: Only a subject\n\nbody")).toEqual({
      subject: "Only a subject",
      fromName: null,
      fromAddress: null,
      receivedAt: null,
      internetMessageId: null,
    });
  });

  it("is null for a file that is not a mail", () => {
    expect(parseEmlHeaders("just some text\nwith lines")).toBeNull();
  });
});

describe("headers", () => {
  it("decodes Q and B words and Latin-1", () => {
    expect(decodeWords("=?iso-8859-1?Q?Caf=E9?= ok")).toBe("Café ok");
    expect(decodeWords("=?utf-8?b?w6DDqA==?= =?utf-8?b?w6w=?=")).toBe("àèì");
    expect(decodeWords("=?unknown-charset?Q?x?=")).toBe("=?unknown-charset?Q?x?=");
  });

  it("reads quoted, plain and bare addresses", () => {
    expect(parseAddress('"Rossi, Giulia" <g@x.it>')).toEqual({ name: "Rossi, Giulia", address: "g@x.it" });
    expect(parseAddress("Giulia <g@x.it>")).toEqual({ name: "Giulia", address: "g@x.it" });
    expect(parseAddress("G@X.it")).toEqual({ name: null, address: "g@x.it" });
    expect(parseAddress("<g@x.it>")).toEqual({ name: null, address: "g@x.it" });
  });
});
