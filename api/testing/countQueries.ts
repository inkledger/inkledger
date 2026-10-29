// Counts the database queries a piece of code costs (docs/dev/measuring.md): every
// query that reaches PGlite through query(), and inside a transaction through the
// transaction's own query(). Installed by a test; stop() takes the counting away.
import { vi } from "vitest";
import { PGlite, type Transaction } from "@electric-sql/pglite";

export type QueryCounter = { readonly n: number; reset(): void; stop(): void };

export function countQueries(): QueryCounter {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with apply/call on the instance below
  const query = PGlite.prototype.query;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- same
  const transaction = PGlite.prototype.transaction;
  const onQuery = vi.spyOn(PGlite.prototype, "query").mockImplementation(function (this: PGlite, ...a: Parameters<PGlite["query"]>) {
    n++;
    return query.apply(this, a);
  } as PGlite["query"]);
  const onTransaction = vi.spyOn(PGlite.prototype, "transaction").mockImplementation(function <T>(this: PGlite, fn: (tx: Transaction) => Promise<T>) {
    return transaction.call(this, (tx: Transaction) => {
      const txQuery = tx.query.bind(tx);
      tx.query = ((...a: Parameters<Transaction["query"]>) => {
        n++;
        return txQuery(...a);
      }) as Transaction["query"];
      return fn(tx);
    });
  });
  return {
    get n() {
      return n;
    },
    reset() {
      n = 0;
    },
    stop() {
      onQuery.mockRestore();
      onTransaction.mockRestore();
    },
  };
}
