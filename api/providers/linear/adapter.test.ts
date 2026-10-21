import { afterEach, describe, expect, it, vi } from "vitest";
import { instant, timeZone } from "@contracts/values";
import type { Credential } from "../types";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import { COMPLEXITY_LIMIT, linearSimulator } from "./simulator";
import { WEBHOOK_MAX_AGE_MS, linearProvider, linearWebhook } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "104.18.0.1", family: 4 }]),
}));

afterEach(() => {
  vi.useRealTimers();
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });

function simulated(credential: () => Promise<Credential> = async () => ({ kind: "token", token: "lin_api_test" })) {
  const sim = linearSimulator();
  sim.addTeam("ENG", "Engineering", { triage: true });
  sim.addTeam("OPS", "Operations", { states: [["Da fare", "unstarted"], ["In revisione", "started"], ["Chiuso", "completed"], ["Annullato", "canceled"]] });
  sim.add("ENG", "Login fails on Safari", { description: "Steps:\n\n1. open\n2. **fail**", priority: 2, estimate: 3, dueDate: "2026-10-30", labels: ["bug"] });
  sim.add("ENG", "Export to CSV");
  sim.add("ENG", "Someone else's", { assignee: sim.addUser("Anna Bianchi") });
  sim.add("OPS", "Rotate certificates", { state: "In revisione" });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 8,
    userId: 1,
    type: "linear" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: sim.me.id,
    options: {},
    timeZone: timeZone("Europe/Rome"),
    credential,
  };
  return { sim, conn, b: bindTracker(linearProvider, conn) };
}

trackerConformance("linear (simulated)", async () => {
  const { conn } = simulated();
  return { provider: linearProvider, conn, key: "ENG-1", writable: true, url: "https://linear.app/acme/issue/ENG-1/login-fails-on-safari" };
});

describe("linear, as the layer sees it", () => {
  it("lists the issues assigned to the user, keyed by identifier, with the team's state and its category", async () => {
    const { b, sim } = simulated();
    const all = await readPass((q) => b.listChanged(meta(), q), null);
    expect(all.items.map((i) => [i.key, i.container.key, i.status.name, i.status.category])).toEqual([
      ["OPS-1", "OPS", "In revisione", "doing"],
      ["ENG-2", "ENG", "Backlog", "backlog"],
      ["ENG-1", "ENG", "Backlog", "backlog"],
    ]);
    expect(all.items.every((i) => i.status.source.kind === "itemState" && i.container.kind === "team")).toBe(true);
    expect(all.gone).toEqual([]);
    // The id is the stable identity, the identifier only its display.
    expect(all.items.find((i) => i.key === "ENG-1")?.remoteId).toBe(sim.find("ENG-1")!.id);
  });

  it("reads priority, estimate, due date and labels as Linear keeps them", async () => {
    const { b, sim } = simulated();
    const i = await b.findIssue(meta(), { key: "ENG-1" });
    if (i.kind !== "found") throw new Error("not found");
    expect(i.issue.priority).toEqual({ id: "2", name: "High", rank: 1 });
    // Points are not time; they stay a field, never estimateSeconds.
    expect(i.issue.estimateSeconds).toBeNull();
    expect(i.issue.fields).toEqual({ estimate: 3 });
    expect(i.issue.labels).toEqual(["bug"]);
    // 0 is "no priority", not the lowest.
    const plain = await b.findIssue(meta(), { key: "ENG-2" });
    expect(plain.kind === "found" && plain.issue.priority).toBeNull();
    // A date without a zone is the day it says, whatever the user's zone or the time of day.
    expect(i.issue.due).toBe("2026-10-30");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 29, 23, 30));
    const late = await b.getIssue(meta(), { remoteId: i.issue.remoteId, key: "ENG-1" });
    expect(late?.due).toBe("2026-10-30");
    // Timestamps are UTC instants.
    expect(i.issue.createdAt).toBe(Date.parse(sim.find("ENG-1")!.createdAt));
  });

  it("dates when a state was entered, by the state's type", async () => {
    const { b, sim } = simulated();
    sim.outside.setState("ENG-1", "Done");
    const done = await b.getIssue(meta(), { remoteId: sim.find("ENG-1")!.id, key: "ENG-1" });
    expect(done?.status).toMatchObject({ name: "Done", category: "done" });
    expect(done?.statusChangedAt).toBe(Date.parse(sim.find("ENG-1")!.completedAt!));
    const todo = await b.getIssue(meta(), { remoteId: sim.find("ENG-2")!.id, key: "ENG-2" });
    expect(todo?.statusChangedAt).toBeNull();
  });

  it("pages by cursor, newest first, and a pass stays whole when an issue is touched meanwhile", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 120; n++) sim.add("OPS", `Bulk ${n}`);
    const total = sim.issues.filter((i) => i.assigneeId === sim.me.id).length;
    const full = await readPass((q) => b.listChanged(meta(), q), null);
    expect(full.pages).toBeGreaterThanOrEqual(3);
    expect(full.items).toHaveLength(total);
    expect(new Set(full.items.map((i) => i.remoteId)).size).toBe(total);
    // Newest-updated first: Linear can't list the other way.
    expect(full.items[0].updatedAt!).toBeGreaterThanOrEqual(full.items.at(-1)!.updatedAt!);

    // Touch the oldest issue after the first page: it jumps to the front, behind the cursor.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(sim.now() + 1000);
    const first = await b.listChanged(meta(), { since: null, page: null });
    if (first.last) throw new Error("expected more pages");
    sim.outside.update("ENG-1", { title: "Login fails everywhere" });
    const seen = new Set(first.items.map((i) => i.remoteId));
    let page = first.next;
    let checkpoint = null;
    for (;;) {
      const p = await b.listChanged(meta(), { since: null, page });
      p.items.forEach((i) => seen.add(i.remoteId));
      if (p.last) {
        checkpoint = p.checkpoint;
        break;
      }
      page = p.next;
    }
    // Everything else was seen; the touched one is for the next pass, which starts before the touch.
    expect(seen.size).toBeGreaterThanOrEqual(total - 1);
    const next = await readPass((q) => b.listChanged(meta(), q), checkpoint);
    expect(next.items.map((i) => i.key)).toContain("ENG-1");
    expect(next.items.find((i) => i.key === "ENG-1")?.title).toBe("Login fails everywhere");
  });

  it("reads only what changed since a checkpoint", async () => {
    const { b, sim } = simulated();
    vi.useFakeTimers({ toFake: ["Date"] });
    // The overlap read again is a minute: the setup is older than that when the first pass runs.
    sim.advance(10 * 60_000);
    vi.setSystemTime(sim.now() + 1000);
    const first = await readPass((q) => b.listChanged(meta(), q), null);
    sim.advance(10 * 60_000);
    sim.outside.setState("ENG-2", "In Progress");
    vi.setSystemTime(sim.now() + 1000);
    const next = await readPass((q) => b.listChanged(meta(), q), first.checkpoint);
    expect(next.items.map((i) => [i.key, i.status.category])).toEqual([["ENG-2", "doing"]]);
    expect(next.checkpoint).not.toBe(first.checkpoint);
  });

  it("reports trashed issues as deleted and issues taken over by someone else as moved out; archived ones stay quiet", async () => {
    const { b, sim } = simulated();
    const anna = [...sim.users.values()].find((u) => u.name === "Anna Bianchi")!;
    const gone = sim.add("OPS", "To trash");
    const away = sim.add("OPS", "To hand over");
    const old = sim.add("OPS", "Auto-archived");
    vi.useFakeTimers({ toFake: ["Date"] });
    sim.advance(10 * 60_000);
    vi.setSystemTime(sim.now() + 1000);
    const first = await readPass((q) => b.listChanged(meta(), q), null);
    expect(first.items.map((i) => i.remoteId)).toEqual(expect.arrayContaining([gone.id, away.id, old.id]));
    sim.advance(10 * 60_000);
    sim.outside.trash("OPS-2");
    sim.outside.assign("OPS-3", anna);
    sim.outside.archive("OPS-4");
    vi.setSystemTime(sim.now() + 1000);
    const next = await readPass((q) => b.listChanged(meta(), q), first.checkpoint);
    expect(next.items).toEqual([]);
    expect(next.gone).toEqual([
      { remoteId: gone.id, reason: "deleted" },
      { remoteId: away.id, reason: "movedOut" },
    ]);
    // A trashed issue is no issue at all; an archived one is still readable.
    expect(await b.getIssue(meta(), { remoteId: gone.id, key: "OPS-2" })).toBeNull();
    expect((await b.getIssue(meta(), { remoteId: old.id, key: "OPS-4" }))?.key).toBe("OPS-4");
    // A first read has nothing to take away: the archived and trashed are simply not listed.
    const again = await readPass((q) => b.listChanged(meta(), q), null);
    expect(again.gone).toEqual([]);
    expect(again.items.map((i) => i.key)).not.toContain("OPS-2");
    expect(again.items.map((i) => i.key)).not.toContain("OPS-4");
  });

  it("parses keys and web links, finds the issue, and follows a move to another team", async () => {
    const { b, sim } = simulated();
    expect(b.normalizeKey("eng-12")).toBe("ENG-12");
    expect(b.normalizeKey("ENG12")).toBeNull();
    expect(b.normalizeKey("TOOLONGKEY-1")).toBeNull();
    // The slug follows the title: only the key counts.
    expect(b.parseRef("https://linear.app/acme/issue/ENG-1/a-title-since-renamed")).toEqual({ key: "ENG-1" });
    expect(b.parseRef("https://linear.app/acme/issue/eng-1")).toEqual({ key: "ENG-1" });
    expect(b.parseRef("https://linear.app/acme/project/ENG-1")).toBeNull();
    expect(b.parseRef("http://linear.app/acme/issue/ENG-1")).toBeNull();
    expect(b.parseRef("https://example.com/acme/issue/ENG-1")).toBeNull();

    const before = await b.findIssue(meta(), { key: "ENG-1" });
    if (before.kind !== "found") throw new Error("not found");
    sim.outside.moveToTeam("ENG-1", "OPS");
    // Same id, new key; the old key still leads there, and says the new one.
    const viaOld = await b.findIssue(meta(), { key: "ENG-1" });
    expect(viaOld.kind === "found" && [viaOld.issue.remoteId, viaOld.issue.key, viaOld.issue.container.key]).toEqual([before.issue.remoteId, "OPS-2", "OPS"]);
    const viaId = await b.getIssue(meta(), { remoteId: before.issue.remoteId, key: "ENG-1" });
    expect(viaId?.key).toBe("OPS-2");
    // And a pass lists it under the new key.
    expect((await readPass((q) => b.listChanged(meta(), q), null)).items.map((i) => i.key)).toContain("OPS-2");
  });

  it("maps every workflow state type to a category, by type and never by name, per team", async () => {
    const { b, sim } = simulated();
    const sources = (await b.probe(meta())).activeSources;
    expect(sources.map((s) => [s.name, s.ref])).toEqual([
      ["Engineering", { kind: "itemState", containerRemoteId: sim.team("ENG").id }],
      ["Operations", { kind: "itemState", containerRemoteId: sim.team("OPS").id }],
    ]);
    const eng = await b.statuses!(meta(), sources[0]);
    expect(eng.map((s) => [s.name, s.category])).toEqual([
      ["Triage", "triage"],
      ["Backlog", "backlog"],
      ["Todo", "todo"],
      ["In Progress", "doing"],
      ["Done", "done"],
      ["Canceled", "cancelled"],
    ]);
    // An Italian team: its own words, the same categories.
    const ops = await b.statuses!(meta(), sources[1]);
    expect(ops.map((s) => [s.name, s.category])).toEqual([
      ["Da fare", "todo"],
      ["In revisione", "doing"],
      ["Chiuso", "done"],
      ["Annullato", "cancelled"],
    ]);
    expect(eng[0].source).toEqual({ kind: "itemState", containerRemoteId: sim.team("ENG").id });
  });

  it("offers any state of the issue's team as a way out, moves along one, and refuses what Linear refuses", async () => {
    const { b, sim } = simulated();
    const ref = { remoteId: sim.find("OPS-1")!.id, key: "OPS-1" };
    const ways = await b.transitions!.list!(meta(), ref);
    expect(ways.map((t) => [t.name, t.to.category])).toEqual([
      ["Da fare", "todo"],
      ["Chiuso", "done"],
      ["Annullato", "cancelled"],
    ]);
    expect(ways.every((t) => t.requirements.length === 0 && /^https:\/\/linear\.app\//.test(t.remoteUrl ?? ""))).toBe(true);
    const cancelled = await b.transitions!.apply!(meta(), ref, ways[2].id, {});
    expect(cancelled?.status).toMatchObject({ name: "Annullato", category: "cancelled" });
    expect(cancelled?.statusChangedAt).not.toBeNull();

    // A state of another team: Linear's validation error (HTTP 200, errors).
    const other = sim.team("ENG").states[0].id;
    await expect(b.transitions!.apply!(meta(), ref, other, {})).rejects.toMatchObject({ kind: "invalid" });
    // A trashed issue: success false, an answer and not an error, still a refusal here.
    sim.outside.trash("OPS-1");
    await expect(b.transitions!.apply!(meta(), ref, ways[0].id, {})).rejects.toMatchObject({ kind: "invalid", message: expect.stringContaining("refused") });
  });

  it("reads the description and comments as CommonMark, integrations' comments too, and writes comments", async () => {
    const { b, sim } = simulated();
    const ref = { remoteId: sim.find("ENG-1")!.id, key: "ENG-1" };
    expect(await b.description!(meta(), ref)).toEqual({ kind: "text", format: "commonmark", text: "Steps:\n\n1. open\n2. **fail**" });
    expect(await b.description!(meta(), { remoteId: sim.find("ENG-2")!.id, key: "ENG-2" })).toBeNull();
    sim.outside.comment("ENG-1", "Deployed to staging", { bot: "GitHub" });
    const added = await b.comments!.add!(meta(), ref, "Looks **fixed**" as never, { idempotencyKey: "c1" });
    expect(added.warnings).toEqual([]);
    const list = await b.comments!.list(meta(), ref);
    // A comment with no user is an integration's: it has an author all the same.
    expect(list.map((c) => [c.author.name, c.body])).toEqual([
      ["GitHub", { kind: "text", format: "commonmark", text: "Deployed to staging" }],
      ["Mario Rossi", { kind: "text", format: "commonmark", text: "Looks **fixed**" }],
    ]);
    expect(list[0].author.remoteId).toMatch(/^bot:/);
    await expect(b.comments!.list(meta(), { remoteId: "nope", key: "ENG-404" })).rejects.toMatchObject({ kind: "notFound" });
  });

  it("subscribes and unsubscribes, and tells an issue's history field by field, oldest first", async () => {
    const { b, sim } = simulated();
    const ref = { remoteId: sim.find("ENG-1")!.id, key: "ENG-1" };
    await b.watch!(meta(), ref, false);
    expect(sim.find("ENG-1")!.subscribers.has(sim.me.id)).toBe(false);
    await b.watch!(meta(), ref, true);
    expect(sim.find("ENG-1")!.subscribers.has(sim.me.id)).toBe(true);

    sim.outside.setState("ENG-1", "In Progress");
    sim.outside.update("ENG-1", { priority: 1, labels: ["bug", "ui"] });
    const anna = sim.addUser("Anna Bianchi");
    sim.outside.assign("ENG-1", anna, anna);
    const changes = await b.history!(meta(), ref);
    expect(changes.map((c) => c.field.id)).toEqual(["state", "priority", "labels", "assignee"]);
    expect(changes[0]).toMatchObject({ from: [{ text: "Backlog" }], to: [{ text: "In Progress" }] });
    expect(changes[1]).toMatchObject({ from: [{ text: "High" }], to: [{ text: "Urgent" }] });
    expect(changes[2]).toMatchObject({ from: [], to: [{ text: "ui" }] });
    expect(changes[3]).toMatchObject({ from: [{ text: "mario" }], to: [{ text: "anna" }], actor: { name: "Anna Bianchi" } });
    expect(changes.map((c) => c.at)).toEqual([...changes.map((c) => c.at)].sort((a, b) => a - b));
  });

  it("searches the workspace's issues by text", async () => {
    const { b } = simulated();
    const r = await b.searchText!(meta(), "csv", 10);
    expect(r.items.map((i) => i.key)).toEqual(["ENG-2"]);
    expect(r.complete).toBe(true);
  });

  it("keeps time in inkledger: no query language, no worklogs", () => {
    expect(linearProvider.capabilities.time).toEqual({ mode: "local", remoteTotals: false });
    expect(linearProvider.worklogs).toBeUndefined();
    expect("query" in linearProvider).toBe(false);
  });
});

describe("linear, the traps of its API", () => {
  it("sends a personal key as is and an OAuth token as Bearer; Bearer with a key is refused", async () => {
    const key = simulated();
    await key.b.verify(meta());
    expect(key.sim.calls.at(-1)?.authorization).toBe("lin_api_test");

    const oauth = simulated(async () => ({ kind: "oauth", accessToken: "oauth_test", expiresAt: instant(Date.now() + 3_600_000) }));
    expect((await oauth.b.verify(meta())).name).toBe("Mario Rossi");
    expect(oauth.sim.calls.at(-1)?.authorization).toBe("Bearer oauth_test");

    // A key behind "Bearer" is what a generic client would send: Linear says 401.
    const wrong = simulated(async () => ({ kind: "oauth", accessToken: "lin_api_test", expiresAt: null }));
    await expect(wrong.b.verify(meta())).rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it("a bad key is an auth error, whatever the call", async () => {
    const { b } = simulated(async () => ({ kind: "token", token: "lin_api_revoked" }));
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "auth" });
    await expect(readPass((q) => b.listChanged(meta(), q), null)).rejects.toMatchObject({ kind: "auth" });
  });

  it("failures arrive as HTTP 200 with errors: a missing issue is notFound, or none when looked up", async () => {
    const { b } = simulated();
    expect(await b.getIssue(meta(), { remoteId: "00000000-0000-4000-8000-999999999999", key: "ENG-999" })).toBeNull();
    expect((await b.findIssue(meta(), { key: "ENG-999" })).kind).toBe("none");
    await expect(b.transitions!.list!(meta(), { remoteId: "x", key: "ENG-999" })).rejects.toMatchObject({ kind: "notFound" });
    await expect(b.watch!(meta(), { remoteId: "x", key: "ENG-999" }, true)).rejects.toMatchObject({ kind: "notFound" });
  });

  it("a spent budget is HTTP 400 RATELIMITED, a wait and not a refusal; 429 too", async () => {
    const { b, sim } = simulated();
    sim.outside.rateLimit(1);
    const err = await b.verify(meta()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rateLimit", status: 400, transient: true });
    const wait = (err as { rateLimit?: { retryAfterMs?: number; remaining?: number } }).rateLimit;
    expect(wait?.remaining).toBe(0);
    expect(wait?.retryAfterMs).toBeGreaterThan(0);
    // The next call goes through.
    expect((await b.verify(meta())).remoteId).toBe(sim.me.id);

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: [{ message: "slow down" }] }), { status: 429, headers: { "retry-after": "30" } }));
    expect(await b.verify(meta()).catch((e: unknown) => e)).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000 } });
    // Whichever budget is empty sets the wait: here the complexity one, in epoch seconds.
    const reset = Math.ceil(Date.now() / 1000) + 90;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] }), { status: 400, headers: { "x-ratelimit-requests-remaining": "100", "x-ratelimit-complexity-remaining": "0", "x-ratelimit-complexity-reset": String(reset) } }));
    const cx = (await b.verify(meta()).catch((e: unknown) => e)) as { kind: string; rateLimit?: { retryAfterMs?: number; resetAt?: number } };
    expect(cx.kind).toBe("rateLimit");
    expect(cx.rateLimit?.resetAt).toBe(reset * 1000);
    expect(cx.rateLimit?.retryAfterMs).toBeGreaterThan(60_000);
  });

  it("a server error is unavailable", async () => {
    const { b } = simulated();
    vi.stubGlobal("fetch", async () => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("keeps every query under the complexity cap and the page cap; heavier ones are refused", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 60; n++) sim.add("OPS", `Bulk ${n}`);
    await readPass((q) => b.listChanged(meta(), q), null);
    await b.searchText!(meta(), "bulk", 250);
    expect(Math.max(...sim.calls.map((c) => c.cost))).toBeLessThanOrEqual(COMPLEXITY_LIMIT);
    const heavy = async (first: number) => {
      const res = await sim.fetch(`${sim.apiBase}/graphql`, { method: "POST", headers: { authorization: "lin_api_test" }, body: JSON.stringify({ operationName: "Issues", query: "", variables: { first } }) });
      return { status: res.status, code: ((await res.json()) as { errors: { extensions: { code: string } }[] }).errors[0].extensions.code };
    };
    // 250 is allowed per page, but its weight is not.
    expect(await heavy(250)).toEqual({ status: 400, code: "QUERY_TOO_COMPLEX" });
    expect(await heavy(251)).toEqual({ status: 400, code: "INPUT_ERROR" });
  });

  it("refuses a checkpoint written by another adapter format", async () => {
    const { b } = simulated();
    await expect(b.listChanged(meta(), { since: "cp1.eyJ9" as never, page: null })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
  });
});

describe("linear webhooks", () => {
  const secret = "lin_wh_secret";
  const payload = { action: "update", type: "Issue", data: { id: "i1", identifier: "ENG-1" } };

  it("accepts a delivery signed with the secret, fresh, and reads its id and time", () => {
    const { sim } = simulated();
    const d = sim.webhook(payload, { secret });
    expect(linearWebhook.verify({ secret, rawBody: d.rawBody, headers: d.headers })).toBe(true);
    expect(linearWebhook.verify({ secret, rawBody: d.rawBody, headers: new Headers(d.headers) })).toBe(true);
    expect(linearWebhook.deliveryId(d.headers)).toMatch(/^[0-9a-f-]{36}$/);
    expect(linearWebhook.sentAt(d.rawBody)).toBeGreaterThan(0);
    expect(linearWebhook.sentAt("not json")).toBeNull();
  });

  it("refuses a wrong secret, a body changed after signing, a missing or malformed signature", () => {
    const { sim } = simulated();
    const d = sim.webhook(payload, { secret, signedWith: "other" });
    expect(linearWebhook.verify({ secret, rawBody: d.rawBody, headers: d.headers })).toBe(false);
    const ok = sim.webhook(payload, { secret });
    expect(linearWebhook.verify({ secret, rawBody: ok.rawBody.replace("update", "remove"), headers: ok.headers })).toBe(false);
    expect(linearWebhook.verify({ secret, rawBody: ok.rawBody, headers: {} })).toBe(false);
    expect(linearWebhook.verify({ secret, rawBody: ok.rawBody, headers: { "Linear-Signature": "zz" } })).toBe(false);
    expect(linearWebhook.verify({ secret, rawBody: ok.rawBody, headers: { "linear-signature": ok.headers["linear-signature"].slice(2) } })).toBe(false);
  });

  it("refuses a replay older than a minute, and a clock far ahead; the header name is case-insensitive", () => {
    const { sim } = simulated();
    const stale = sim.webhook(payload, { secret, ageMs: WEBHOOK_MAX_AGE_MS + 1000 });
    expect(linearWebhook.verify({ secret, rawBody: stale.rawBody, headers: stale.headers })).toBe(false);
    const edge = sim.webhook(payload, { secret, ageMs: WEBHOOK_MAX_AGE_MS - 5000 });
    expect(linearWebhook.verify({ secret, rawBody: edge.rawBody, headers: { "Linear-Signature": edge.headers["linear-signature"] } })).toBe(true);
    const fresh = sim.webhook(payload, { secret });
    expect(linearWebhook.verify({ secret, rawBody: fresh.rawBody, headers: fresh.headers, now: Date.now() - 5 * 60_000 })).toBe(false);
    // Signed, but without the timestamp that makes it replay-proof.
    const bare = JSON.stringify(payload);
    const sig = sim.webhook(payload, { secret }).headers["linear-signature"];
    expect(linearWebhook.verify({ secret, rawBody: bare, headers: { "linear-signature": sig } })).toBe(false);
  });
});
