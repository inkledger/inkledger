const CLIENT_KEY = "ikl-workspace-client";
let interactionEpoch = 1;
let activeTasks = 0;
const idleWaiters = new Set<() => void>();

export function workspaceClientInstanceId(): string {
  if (typeof window === "undefined") return "ssr";
  if (document.getElementById("inkledger-ssr-state")) return "ssr";
  try {
    const existing = sessionStorage.getItem(CLIENT_KEY);
    if (existing) return existing;
    const created = `ci_${crypto.randomUUID()}`;
    sessionStorage.setItem(CLIENT_KEY, created);
    return created;
  } catch {
    return `ci_${crypto.randomUUID()}`;
  }
}

export function workspaceInteractionEpoch(): number {
  return interactionEpoch;
}

export function workspaceTaskActive(): boolean {
  return activeTasks > 0;
}

export function beginWorkspaceTask(): () => void {
  activeTasks++;
  interactionEpoch++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeTasks = Math.max(0, activeTasks - 1);
    if (activeTasks > 0) return;
    interactionEpoch++;
    const waiting = [...idleWaiters];
    idleWaiters.clear();
    for (const resolve of waiting) resolve();
  };
}

/** Resolves once no task is running: the safe boundary a deferred activation waits for (T-01). */
export function whenWorkspaceIdle(): Promise<void> {
  if (activeTasks === 0) return Promise.resolve();
  return new Promise(resolve => idleWaiters.add(resolve));
}

