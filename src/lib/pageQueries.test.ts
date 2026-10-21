import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { pageQueries } from "./pageQueries";

const watch = async (client: QueryClient, key: string) => {
  const observer = new QueryObserver(client, { queryKey: [key], queryFn: () => key, staleTime: Infinity });
  const stop = observer.subscribe(() => undefined);
  await client.fetchQuery({ queryKey: [key], queryFn: () => key });
  return stop;
};
const cached = (client: QueryClient, key: string) => client.getQueryCache().find({ queryKey: [key] }) !== undefined;

describe("pageQueries", () => {
  it("drops only the queries the failed page read, once they are no longer read", async () => {
    const client = new QueryClient();
    let at = "/issues";
    const tracked = pageQueries(client, () => at);
    // Another page, visited before: its data stays cached for a way back.
    (await watch(client, "issues"))();
    // The shell reads on throughout.
    await watch(client, "timers");
    // The page that then fails.
    at = "/reports";
    (await watch(client, "report"))();
    tracked.dropInactive("/reports");
    expect(cached(client, "report")).toBe(false);
    expect(cached(client, "issues")).toBe(true);
    expect(cached(client, "timers")).toBe(true);
    tracked.stop();
  });

  it("a page that failed on its first draw, from cached data it never got to watch, reads it afresh too", async () => {
    const client = new QueryClient();
    let at = "/issues";
    const tracked = pageQueries(client, () => at);
    (await watch(client, "issues"))();
    // On to a page drawn from that cache, which throws before it commits: read, never watched.
    at = "/timesheet";
    new QueryObserver(client, { queryKey: ["issues"], queryFn: () => "issues", staleTime: Infinity });
    tracked.dropInactive("/timesheet");
    expect(cached(client, "issues")).toBe(false);
    tracked.stop();
  });
});
