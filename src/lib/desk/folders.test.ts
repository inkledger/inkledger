// Folders connected in a browser for the Desk chat: kept in IndexedDB, one record per folder.
import { afterEach, describe, expect, it, vi } from "vitest";

/** A small IndexedDB: one database of object stores keyed by "id", each call answered on a later turn. */
function fakeIndexedDb() {
  const stores = new Map<string, Map<string, unknown>>();
  const later = <T,>(work: () => T) => {
    const req: { result?: T; error: null; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void } = { error: null };
    setTimeout(() => {
      req.result = work();
      req.onsuccess?.();
    }, 0);
    return req;
  };
  const db = {
    createObjectStore: (name: string) => stores.set(name, new Map()),
    transaction: (name: string) => ({
      objectStore: () => {
        const store = stores.get(name)!;
        return {
          put: (v: { id: string }) => later(() => store.set(v.id, v) && v.id),
          delete: (id: string) => later(() => void store.delete(id)),
          getAll: () => later(() => [...store.values()]),
        };
      },
    }),
    close: () => {},
  };
  return {
    stores,
    open: () => {
      const req: { result?: typeof db; error: null; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void } = { error: null };
      setTimeout(() => {
        req.result = db;
        if (!stores.size) req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
    deleteDatabase: () => stores.clear(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("connectFolder", () => {
  it("connecting the same folder again replaces its stored record: no copy comes back after a reload", async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal("indexedDB", idb);
    vi.stubGlobal("window", { showDirectoryPicker: async () => ({ kind: "directory", name: "shop" }) });
    const { connectFolder } = await import("./folders");
    const first = await connectFolder(7);
    const second = await connectFolder(7);
    expect(second?.id).not.toBe(first?.id);
    expect([...(idb.stores.get("folders")?.keys() ?? [])]).toEqual([second?.id]);
  });
});
