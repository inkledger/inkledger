import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  adfFromText,
  textFromAdf,
  getMyself,
  fetchAssignedIssues,
  addWorklog,
  JiraApiError,
  searchIssues,
  fetchIssueByKey,
  fetchFromSite,
  isAuthor,
  isNetworkError,
} from "./client";

// Redirect targets are re-validated with a DNS lookup: no real DNS in tests.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const creds = {
  siteUrl: "https://example.atlassian.net/",
  deployment: "cloud" as const,
  authType: "basic" as const,
  username: "user@example.com",
  secret: "token",
};

const serverCreds = {
  siteUrl: "https://jira.example.it/",
  deployment: "server" as const,
  authType: "basic" as const,
  username: "mario.rossi",
  secret: "password123",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ADF helpers", () => {
  it("converts text to ADF paragraphs", () => {
    const adf = adfFromText("line one\nline two");
    expect(adf.type).toBe("doc");
    expect(adf.content).toHaveLength(2);
    expect(adf.content[0].content[0]).toEqual({ type: "text", text: "line one" });
  });

  it("converts ADF back to plain text", () => {
    expect(textFromAdf(adfFromText("hello\nworld")).trim()).toBe("hello\nworld");
  });

  it("keeps links as wiki markup (text, smart links)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See " },
            { type: "text", text: "the sheet", marks: [{ type: "link", attrs: { href: "https://docs.google.com/x" } }] },
            { type: "text", text: " and " },
            { type: "inlineCard", attrs: { url: "https://drive.google.com/y" } },
          ],
        },
        { type: "blockCard", attrs: { url: "https://acme.atlassian.net/wiki/z" } },
      ],
    };
    expect(textFromAdf(doc)).toBe(
      "See [the sheet|https://docs.google.com/x] and [https://drive.google.com/y]\n[https://acme.atlassian.net/wiki/z]\n",
    );
  });

  it("handles strings and nullish values", () => {
    expect(textFromAdf("plain")).toBe("plain");
    expect(textFromAdf(undefined)).toBe("");
    expect(textFromAdf(null)).toBe("");
  });
});

describe("Jira API client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends basic auth and normalizes the site URL", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ accountId: "abc", displayName: "Mario" }),
    );
    const me = await getMyself(creds);
    expect(me.accountId).toBe("abc");
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://example.atlassian.net/rest/api/3/myself");
    const expected =
      "Basic " + Buffer.from("user@example.com:token").toString("base64");
    expect((init.headers as Record<string, string>).Authorization).toBe(expected);
  });

  it("throws JiraApiError with Jira error messages", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ errorMessages: ["Site does not exist"] }, 404),
    );
    await expect(getMyself(creds)).rejects.toMatchObject({
      name: "JiraApiError",
      status: 404,
      message: "Site does not exist",
    });

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ errorMessages: ["Unauthorized"] }, 401),
    );
    await expect(getMyself(creds)).rejects.toBeInstanceOf(JiraApiError);
  });

  it("paginates the JQL search until isLast", async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(
      jsonResponse({
        issues: [{ id: "1", key: "PRJ-1", fields: { summary: "A" } }],
        nextPageToken: "tok2",
        isLast: false,
      }),
    );
    mock.mockResolvedValueOnce(
      jsonResponse({
        issues: [{ id: "2", key: "PRJ-2", fields: { summary: "B" } }],
        isLast: true,
      }),
    );
    const issues = await fetchAssignedIssues(creds);
    expect(issues.map((i) => i.key)).toEqual(["PRJ-1", "PRJ-2"]);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(String(mock.mock.calls[1][0])).toContain("nextPageToken=tok2");
  });

  it("posts a worklog with ADF comment", async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(
      jsonResponse({ id: "10001", timeSpentSeconds: 3600 }),
    );
    const wl = await addWorklog(creds, "PRJ-1", {
      timeSpentSeconds: 3600,
      started: "2026-07-20T10:00:00.000+0000",
      comment: "work done",
    });
    expect(wl.id).toBe("10001");
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toContain("/rest/api/3/issue/PRJ-1/worklog");
    const body = JSON.parse(String(init?.body));
    expect(body.timeSpentSeconds).toBe(3600);
    expect(body.comment.type).toBe("doc");
  });
});

describe("Jira Server / DC 8.x mode", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses REST API v2 and basic auth with username", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ name: "mario.rossi", displayName: "Mario Rossi" }),
    );
    const me = await getMyself(serverCreds);
    expect(me.name).toBe("mario.rossi");
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://jira.example.it/rest/api/2/myself");
    const expected =
      "Basic " + Buffer.from("mario.rossi:password123").toString("base64");
    expect((init.headers as Record<string, string>).Authorization).toBe(expected);
  });

  it("supports Personal Access Token bearer auth (DC 8.14+)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ name: "mario.rossi", displayName: "Mario Rossi" }),
    );
    await getMyself({ ...serverCreds, authType: "bearer", secret: "pat-xyz" });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer pat-xyz",
    );
  });

  it("paginates /rest/api/2/search with startAt until total", async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    const mkIssue = (n: number) => ({
      id: String(n),
      key: `SRV-${n}`,
      fields: { summary: `Issue ${n}` },
    });
    // pageSize is 100: first page full (100 issues, total 101), second page 1 issue
    mock.mockResolvedValueOnce(
      jsonResponse({
        issues: Array.from({ length: 100 }, (_, i) => mkIssue(i + 1)),
        total: 101,
      }),
    );
    mock.mockResolvedValueOnce(
      jsonResponse({ issues: [mkIssue(101)], total: 101 }),
    );
    const issues = await fetchAssignedIssues(serverCreds);
    expect(issues).toHaveLength(101);
    expect(issues[100].key).toBe("SRV-101");
    expect(String(mock.mock.calls[0][0])).toContain("/rest/api/2/search");
    expect(String(mock.mock.calls[0][0])).toContain("startAt=0");
    expect(String(mock.mock.calls[1][0])).toContain("startAt=100");
  });

  it("sends plain-text comments on worklogs (no ADF)", async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(
      jsonResponse({ id: "20001", timeSpentSeconds: 1800 }),
    );
    await addWorklog(serverCreds, "SRV-1", {
      timeSpentSeconds: 1800,
      started: "2026-07-20T10:00:00.000+0200",
      comment: "test server",
    });
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toContain("/rest/api/2/issue/SRV-1/worklog");
    const body = JSON.parse(String(init?.body));
    expect(body.comment).toBe("test server");
  });
});

describe("redirects (SSRF)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const redirect = (location: string, status = 302) =>
    new Response(null, { status, headers: { Location: location } });

  it("never follows a redirect to another origin (cloud metadata)", async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(redirect("http://169.254.169.254/latest/meta-data/"));
    await expect(getMyself(creds)).rejects.toMatchObject({
      name: "JiraApiError",
      status: 502,
      message: "Redirect not allowed",
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][1].redirect).toBe("manual");
  });

  it("follows same-origin redirects, at most 3", async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(redirect("/rest/api/3/myself?moved=1", 301));
    mock.mockResolvedValueOnce(jsonResponse({ accountId: "abc", displayName: "Mario" }));
    expect((await getMyself(creds)).accountId).toBe("abc");
    expect(String(mock.mock.calls[1][0])).toBe("https://example.atlassian.net/rest/api/3/myself?moved=1");
    expect(new Headers(mock.mock.calls[1][1].headers).get("Authorization")).toMatch(/^Basic /);

    mock.mockReset();
    mock.mockImplementation(async () => redirect("/again"));
    await expect(getMyself(creds)).rejects.toMatchObject({ status: 502 });
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it("attachments: Cloud may hop to its media CDN, without credentials; Server may not", async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(redirect("https://api.media.atlassian.com/file/x?token=t"));
    mock.mockResolvedValueOnce(new Response("data"));
    const res = await fetchFromSite(creds, "https://example.atlassian.net/secure/attachment/1/a.png");
    expect(await res.text()).toBe("data");
    expect(new Headers(mock.mock.calls[1][1].headers).get("Authorization")).toBeNull();

    mock.mockResolvedValueOnce(redirect("https://elsewhere.example/x"));
    await expect(
      fetchFromSite(serverCreds, "https://jira.example.it/secure/attachment/1/a.png"),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("server pagination and single issues", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const mkIssue = (n: number) => ({ id: String(n), key: `SRV-${n}`, fields: { summary: `Issue ${n}` } });

  it("advances startAt by the issues returned when Jira caps the page size", async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(jsonResponse({ issues: Array.from({ length: 50 }, (_, i) => mkIssue(i)), total: 120 }));
    mock.mockResolvedValueOnce(jsonResponse({ issues: Array.from({ length: 50 }, (_, i) => mkIssue(50 + i)), total: 120 }));
    mock.mockResolvedValueOnce(jsonResponse({ issues: Array.from({ length: 20 }, (_, i) => mkIssue(100 + i)), total: 120 }));
    const issues = await searchIssues(serverCreds, "assignee = currentUser()");
    expect(issues.map((i) => i.key)).toEqual(Array.from({ length: 120 }, (_, i) => `SRV-${i}`));
    expect(mock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("startAt"))).toEqual(["0", "50", "100"]);
  });

  it("stops on an empty page even if total says otherwise", async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(jsonResponse({ issues: [mkIssue(1)], total: 5 }));
    mock.mockResolvedValueOnce(jsonResponse({ issues: [], total: 5 }));
    expect(await searchIssues(serverCreds, "x")).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("fetches one issue by key; null when Jira does not know it", async () => {
    const mock = fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(jsonResponse(mkIssue(7)));
    expect((await fetchIssueByKey(serverCreds, "SRV-7"))?.key).toBe("SRV-7");
    expect(String(mock.mock.calls[0][0])).toContain("/rest/api/2/issue/SRV-7?fields=summary,");
    mock.mockResolvedValueOnce(jsonResponse({ errorMessages: ["Issue does not exist"] }, 404));
    expect(await fetchIssueByKey(serverCreds, "SRV-8")).toBeNull();
    mock.mockResolvedValueOnce(jsonResponse({ errorMessages: ["bad"] }, 400));
    expect(await fetchIssueByKey(serverCreds, "SRV-9")).toBeNull();
  });
});

describe("canonicalCategory", () => {
  it("maps the language-independent key, not the localized name", async () => {
    const { canonicalCategory } = await import("./client");
    expect(canonicalCategory({ key: "done", name: "Completato" })).toBe("Done");
    expect(canonicalCategory({ key: "new", name: "Da completare" })).toBe("To Do");
    expect(canonicalCategory({ key: "indeterminate", name: "In corso" })).toBe("In Progress");
    expect(canonicalCategory({ name: "Custom" })).toBe("Custom");
    expect(canonicalCategory(undefined)).toBe("");
  });
});

describe("isNetworkError", () => {
  it("is true only for unreachable Jira, not for bugs", () => {
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkError(Object.assign(new TypeError("x"), { cause: { code: "ECONNREFUSED" } }))).toBe(true);
    expect(isNetworkError(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isNetworkError(new Error("boom"))).toBe(false);
    expect(isNetworkError("fetch failed")).toBe(false);
  });
});

describe("isAuthor", () => {
  it("matches Cloud accountId and Server name or key", () => {
    expect(isAuthor({ accountId: "abc" }, "abc")).toBe(true);
    expect(isAuthor({ name: "mrossi" }, "mrossi")).toBe(true);
    expect(isAuthor({ key: "JIRAUSER10100" }, "JIRAUSER10100")).toBe(true);
    expect(isAuthor({ name: "other" }, "mrossi")).toBe(false);
    expect(isAuthor(undefined, "mrossi")).toBe(false);
  });
});
