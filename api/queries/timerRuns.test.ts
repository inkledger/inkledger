import { describe, expect, it } from "vitest";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@db/schema";
import { closeRun, consumeRuns, discardRuns, openRun, pruneRuns, recordShares, renameRuns, splitInputs, trimRuns, unconsumeRuns } from "./timerRuns";

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 3, h, m));

/** A migrated database: Ann (user 1, one Jira) with two timers' worth of issues. */
async function database() {
  const client = new PGlite({ extensions: { pg_trgm } });
  await migrate(drizzle(client), { migrationsFolder: path.join(import.meta.dirname, "../../drizzle") });
  const db = drizzle(client, { schema });
  const q = async (text: string, ...params: unknown[]) => (await client.query(text, params)).rows as Record<string, unknown>[];
  await q("INSERT INTO users (id, email, display_name, created_at) VALUES (1, 'ann@example.com', 'Ann', 1)");
  const [{ id }] = await q("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, legacy, created_at) VALUES (1, 'jira', 'https://ann.atlassian.net', 'acc-1', '{}', 'e', 1, 1) RETURNING id");
  const connectionId = Number(id);
  const timer = async (key: string) => q("INSERT INTO timers (user_id, connection_id, issue_key, started_at, created_at, updated_at) VALUES (1, $1, $2, 1, 1, 1)", connectionId, key);
  const runs = async () =>
    (await q("SELECT issue_key, started_at, ended_at, logged_at FROM timer_runs ORDER BY issue_key, started_at")).map((r) => ({
      key: r.issue_key,
      start: Number(r.started_at),
      end: r.ended_at === null ? null : Number(r.ended_at),
      logged: r.logged_at !== null,
    }));
  // drizzle's pglite database stands in for the app's (same query builder).
  return { db: db as unknown as Parameters<typeof openRun>[0], q, connectionId, timer, runs, close: () => client.close() };
}

describe("timer runs", () => {
  it("open, close, open again: one open run at a time", async () => {
    const { db, connectionId, runs, close } = await database();
    const a = { userId: 1, connectionId, issueKey: "A-1" };
    await openRun(db, a, at(9));
    await openRun(db, a, at(9, 5));
    await closeRun(db, a, at(10));
    await openRun(db, a, at(11));
    expect(await runs()).toEqual([
      { key: "A-1", start: at(9).getTime(), end: at(10).getTime(), logged: false },
      { key: "A-1", start: at(11).getTime(), end: null, logged: false },
    ]);
    await close();
  });

  it("a trim takes the last minutes off, newest run first", async () => {
    const { db, connectionId, runs, close } = await database();
    const a = { userId: 1, connectionId, issueKey: "A-1" };
    await openRun(db, a, at(9));
    await closeRun(db, a, at(10));
    await openRun(db, a, at(11));
    // 11:00–11:20 open (now 11:20) and 20 min of 9–10: 40 min away.
    await trimRuns(db, a, 40 * 60, at(11, 20));
    expect(await runs()).toEqual([{ key: "A-1", start: at(9).getTime(), end: at(9, 40).getTime(), logged: false }]);
    await close();
  });

  it("a log consumes up to its end, cutting an open run; undo puts it all back", async () => {
    const { db, connectionId, runs, close } = await database();
    const a = { userId: 1, connectionId, issueKey: "A-1" };
    await openRun(db, a, at(9));
    const before = await runs();
    const consumed = await consumeRuns(db, a, at(10), at(10));
    consumed.shares = await recordShares(db, a, [{ start: at(9, 30).getTime(), end: at(10).getTime(), bp: 6000 }]);
    expect(await runs()).toEqual([
      { key: "A-1", start: at(9).getTime(), end: at(10).getTime(), logged: true },
      { key: "A-1", start: at(10).getTime(), end: null, logged: false },
    ]);
    await unconsumeRuns(db, consumed);
    expect(await runs()).toEqual(before);
    await close();
  });

  it("what a split reads: the timer's span, every timer's runs and shares in it", async () => {
    const { db, connectionId, close } = await database();
    const a = { userId: 1, connectionId, issueKey: "A-1" };
    const b = { userId: 1, connectionId, issueKey: "B-1" };
    await openRun(db, a, at(9));
    await closeRun(db, a, at(11));
    await openRun(db, b, at(10, 20));
    await openRun(db, b, at(7));
    await consumeRuns(db, a, at(11), at(11));
    await recordShares(db, a, [{ start: at(10, 20).getTime(), end: at(11).getTime(), bp: 6000 }]);
    const read = await splitInputs(db, b, at(11, 30));
    expect(read.runs).toEqual([
      { timer: `${connectionId}:A-1`, start: at(9).getTime(), end: at(11).getTime(), logged: true },
      { timer: `${connectionId}:B-1`, start: at(10, 20).getTime(), end: at(11, 30).getTime(), logged: false },
    ]);
    expect(read.shares).toEqual([{ timer: `${connectionId}:A-1`, start: at(10, 20).getTime(), end: at(11).getTime(), bp: 6000 }]);
    await close();
  });

  it("moved to another issue, discarded, pruned once no timer still to log needs them", async () => {
    const { db, connectionId, timer, runs, close } = await database();
    const a = { userId: 1, connectionId, issueKey: "A-1" };
    const b = { userId: 1, connectionId, issueKey: "B-1" };
    await openRun(db, a, at(9));
    await closeRun(db, a, at(10));
    await renameRuns(db, 1, { connectionId, issueKey: "A-1" }, { connectionId, issueKey: "C-1" });
    expect((await runs()).map((r) => r.key)).toEqual(["C-1"]);
    await discardRuns(db, { ...a, issueKey: "C-1" });
    expect(await runs()).toEqual([]);
    // A logged beside B still running: kept while B is to log, gone after B's log.
    await timer("B-1");
    await openRun(db, a, at(9));
    await closeRun(db, a, at(11));
    await openRun(db, b, at(10));
    await consumeRuns(db, a, at(11), at(11));
    await recordShares(db, a, [{ start: at(10).getTime(), end: at(11).getTime(), bp: 5000 }]);
    await pruneRuns(db, 1, at(11, 30));
    expect((await runs()).map((r) => r.key)).toEqual(["A-1", "B-1"]);
    await consumeRuns(db, b, at(11, 30), at(11, 30));
    await pruneRuns(db, 1, at(11, 30));
    // B runs on: only its new run is left.
    expect(await runs()).toEqual([{ key: "B-1", start: at(11, 30).getTime(), end: null, logged: false }]);
    await close();
  });

  it("an unlogged run whose timer is gone is pruned", async () => {
    const { db, connectionId, runs, close } = await database();
    await openRun(db, { userId: 1, connectionId, issueKey: "GONE-1" }, at(9));
    await pruneRuns(db, 1, at(10));
    expect(await runs()).toEqual([]);
    await close();
  });
});
