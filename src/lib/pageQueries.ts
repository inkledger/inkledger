import type { QueryClient } from "@tanstack/react-query";

/**
 * Which page read each query (the path it was last read on), so a Retry after
 * a page failed drops that page's queries it no longer reads and it reads
 * them afresh; every other page's cache stays. A read is any draw that asks
 * the cache for the query (`build`), so a page that throws on its first draw,
 * before it ever watches what it read, counts too.
 */
export function pageQueries(client: QueryClient, path: () => string = () => window.location.pathname) {
  const cache = client.getQueryCache();
  const readOn = new Map<string, string>();
  const build = cache.build.bind(cache);
  cache.build = ((...args: Parameters<typeof build>) => {
    const query = build(...args);
    readOn.set(query.queryHash, path());
    return query;
  }) as typeof cache.build;
  const unsubscribe = cache.subscribe(e => {
    if (e.type === "removed") readOn.delete(e.query.queryHash);
  });
  return {
    dropInactive(page: string) {
      for (const [hash, on] of readOn) {
        const q = cache.get(hash);
        if (on === page && q && q.getObserversCount() === 0) cache.remove(q);
      }
    },
    stop() {
      unsubscribe();
      cache.build = build;
    },
  };
}

const tracked = new WeakMap<QueryClient, ReturnType<typeof pageQueries>>();

/** The app's one tracker per client: made with the client, before any page reads. */
export function pageQueriesOf(client: QueryClient) {
  let t = tracked.get(client);
  if (!t) tracked.set(client, (t = pageQueries(client)));
  return t;
}
