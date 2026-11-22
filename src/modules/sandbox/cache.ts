/**
 * A framed module's local cache ("cache"): the frame's own IndexedDB throws
 * (opaque origin), so the host keeps one per module, on this device only, at
 * most 32 MB each; what was written longest ago goes first to make room.
 */

export const CACHE_MAX_BYTES = 32 * 1024 * 1024;

export type CacheEntry = { key: string; size: number; at: number };
export type CacheBackend = {
  get(moduleId: string, key: string): Promise<Blob | null>;
  put(moduleId: string, key: string, value: Blob, at: number): Promise<void>;
  delete(moduleId: string, key: string): Promise<void>;
  entries(moduleId: string): Promise<CacheEntry[]>;
};

export function createModuleCache(backend: CacheBackend, now: () => number = Date.now) {
  // One write at a time per module: the room counted is the room there is.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(moduleId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(moduleId) ?? Promise.resolve()).then(fn, fn);
    queues.set(moduleId, run.catch(() => undefined));
    return run;
  };
  return {
    get: (moduleId: string, key: string) => backend.get(moduleId, key),
    put: (moduleId: string, key: string, value: Blob) =>
      serial(moduleId, async () => {
        if (value.size > CACHE_MAX_BYTES) throw new Error("cache: too big");
        const others = (await backend.entries(moduleId)).filter(e => e.key !== key).sort((a, b) => a.at - b.at);
        let total = others.reduce((n, e) => n + e.size, 0);
        for (const e of others) {
          if (total + value.size <= CACHE_MAX_BYTES) break;
          await backend.delete(moduleId, e.key);
          total -= e.size;
        }
        await backend.put(moduleId, key, value, now());
      }),
    delete: (moduleId: string, key: string) => serial(moduleId, () => backend.delete(moduleId, key)),
  };
}

type Row = { moduleId: string; key: string; value: Blob; size: number; at: number };
const DB = "ikl-module-cache";
const STORE = "entries";

/** The browser's IndexedDB, one database for every module (each row under its module). */
export function indexedDbCache(): CacheBackend {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: ["moduleId", "key"] }).createIndex("moduleId", "moduleId");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        db = null;
        reject(req.error ?? new Error("cache: unavailable"));
      };
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const tx = (await open()).transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("cache: failed"));
    });
  };
  return {
    async get(moduleId, key) {
      const row = (await run("readonly", s => s.get([moduleId, key]))) as Row | undefined;
      return row?.value ?? null;
    },
    async put(moduleId, key, value, at) {
      const row: Row = { moduleId, key, value, size: value.size, at };
      await run("readwrite", s => s.put(row));
    },
    async delete(moduleId, key) {
      await run("readwrite", s => s.delete([moduleId, key]));
    },
    async entries(moduleId) {
      const rows = (await run("readonly", s => s.index("moduleId").getAll(moduleId))) as Row[];
      return rows.map(r => ({ key: r.key, size: r.size, at: r.at }));
    },
  };
}
