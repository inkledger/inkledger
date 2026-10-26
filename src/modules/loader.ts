import { readStored, writeStored } from "@/lib/storage";
import type { ModuleListEntry } from "@contracts/modules";
import type { InkledgerModuleV1 } from "./types";

const OFF_KEY = "inkledger-modules-off";

/** Kill switch: ?modules=off, or the toggle in Settings → Extras (per device). */
export function modulesDisabled(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("modules") === "off") return true;
  return readStored(OFF_KEY) === "1";
}

export function setModulesDisabled(off: boolean) {
  // Storage unavailable: nothing to remember.
  writeStored(OFF_KEY, off ? "1" : null);
}

export type LoadedModule = { entry: ModuleListEntry; module: InkledgerModuleV1 };

const cache = new Map<string, Promise<InkledgerModuleV1 | null>>();

function isModule(v: unknown, id: string): v is InkledgerModuleV1 {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return m.id === id && m.hostApi === 1 && typeof m.mount === "object" && m.mount !== null;
}

/**
 * One module's code: fetched once with its integrity (the bytes the server
 * hashed), then imported from the same immutable URL. Any failure drops just
 * this module.
 */
function load(entry: ModuleListEntry): Promise<InkledgerModuleV1 | null> {
  const url = entry.entryUrl;
  if (!url || !entry.integrity) return Promise.resolve(null);
  const hit = cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    try {
      const res = await fetch(url, { integrity: entry.integrity ?? undefined, credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
      if (!isModule(mod.default, entry.id)) throw new Error("not an inkledger module (v1)");
      return mod.default;
    } catch (e) {
      console.error(`[module ${entry.id}] not loaded`, e);
      return null;
    }
  })();
  cache.set(url, p);
  return p;
}

export async function loadModules(entries: ModuleListEntry[]): Promise<LoadedModule[]> {
  const active = entries.filter(e => e.status.state === "active");
  const loaded = await Promise.all(active.map(async entry => ({ entry, module: await load(entry) })));
  return loaded.flatMap(l => (l.module ? [{ entry: l.entry, module: l.module }] : []));
}
