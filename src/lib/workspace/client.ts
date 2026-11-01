const CLIENT_KEY = "ikl-workspace-client";
let interactionEpoch = 1;
let activeTasks = 0;

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
    if (activeTasks === 0) interactionEpoch++;
  };
}

export function resetWorkspaceTasksForTests(): void {
  interactionEpoch = 1;
  activeTasks = 0;
}
