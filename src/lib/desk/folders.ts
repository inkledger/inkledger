import { useSyncExternalStore } from "react";
import { randomUUID } from "@/lib/randomId";
import { isNative } from "@/lib/native";
import type { DirHandle } from "./browserCode";

/**
 * Folders connected in a browser for the Desk chat (docs/work/desk.md, batch 4d): the user
 * picks a project's repository with the File System Access API (Chrome, Edge); the handle is
 * kept in this browser's IndexedDB so the folder stays connected, and reading it again may
 * need the browser's permission once more. Nothing here reaches the server. Storage can fail
 * (a private window, a handle that can't be stored): the folder then lasts until a reload.
 */

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
    requestPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
  }
}

type Permissions = { queryPermission?: FileSystemHandle["queryPermission"]; requestPermission?: FileSystemHandle["requestPermission"] };
export type FolderHandle = DirHandle & Permissions;
export type Folder = { id: string; containerId: number; name: string; handle: FolderHandle };

const DB = "inkledger-desk-code";
const STORE = "folders";

let folders: Folder[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const set = (next: Folder[]) => {
  folders = next;
  listeners.forEach(l => l());
};

/** A folder can be connected here: a browser with the File System Access API (not the app, which reads by itself). */
export function canConnectFolders(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function" && !isNative();
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = work(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
    });
  } finally {
    db.close();
  }
}

const isFolder = (v: unknown): v is Folder =>
  typeof v === "object" && v !== null && "id" in v && "containerId" in v && "handle" in v && typeof v.id === "string" && typeof v.containerId === "number";

/** The folders this browser keeps (read once; then those connected since). */
async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const stored: unknown[] = await withStore("readonly", s => s.getAll());
    const kept = stored.filter(isFolder);
    set([...kept.filter(f => !folders.some(g => g.id === f.id)), ...folders]);
  } catch {
    // No IndexedDB here (a private window): the folders last until a reload.
  }
}

export function useFolders(): Folder[] {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      if (canConnectFolders()) void load();
      return () => listeners.delete(l);
    },
    () => folders,
    () => folders,
  );
}

/** Asks for a project's folder; null when the user cancels. Kept in IndexedDB when it can be. */
export async function connectFolder(containerId: number): Promise<Folder | null> {
  if (!window.showDirectoryPicker) return null;
  let handle: FolderHandle;
  try {
    handle = await window.showDirectoryPicker({ id: `ikl-code-${containerId}`, mode: "read" });
  } catch {
    // Cancelled, or the browser refused (a system folder).
    return null;
  }
  const folder: Folder = { id: randomUUID(), containerId, name: handle.name, handle };
  set([...folders.filter(f => !(f.containerId === containerId && f.name === folder.name)), folder]);
  try {
    await withStore("readwrite", s => s.put(folder));
  } catch {
    // A handle that can't be stored (or no IndexedDB): connected until a reload.
  }
  return folder;
}

export async function forgetFolder(id: string): Promise<void> {
  set(folders.filter(f => f.id !== id));
  try {
    await withStore("readwrite", s => s.delete(id));
  } catch {
    // Nothing stored: nothing to forget.
  }
}

/** Whether the folder can be read now; `ask` asks the browser again (needs a click). */
export async function readable(folder: Folder, ask: boolean): Promise<boolean> {
  try {
    const state = (await folder.handle.queryPermission?.({ mode: "read" })) ?? "granted";
    if (state === "granted") return true;
    if (!ask) return false;
    return ((await folder.handle.requestPermission?.({ mode: "read" })) ?? "granted") === "granted";
  } catch {
    return false;
  }
}
