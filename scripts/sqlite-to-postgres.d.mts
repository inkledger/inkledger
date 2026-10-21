import type { Database } from "better-sqlite3";

export const TABLES: string[];

/** Anything with pg's `query(text, params)` returning `{ rows }` (pg.Client, PGlite). */
type QueryClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export function reencrypt(payload: string, fromSecret: string, toSecret: string): string;

/** Copies every table in one transaction; `{ table: [sourceRows, targetRows] }`. */
export function transfer(opts: {
  sqlite: Database;
  client: QueryClient;
  fromSecret: string;
  toSecret: string;
  wipe?: boolean;
}): Promise<Record<string, [number, number]>>;
