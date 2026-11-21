import { useEffect } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { beginWorkspaceTask } from "./client";

/**
 * Whether a mutation under way holds a layout change back (T-01): the user's own saves do. The layout's
 * own calls don't, nor the timer's background heartbeat, which beats as soon as a timer starts and every
 * 25 s after: it would hold back (or interrupt) a change made right after starting a timer.
 */
export function holdsLayout(mutationKey: unknown): boolean {
  const key = JSON.stringify(mutationKey) ?? "";
  return !key.includes('"workspace"') && !key.includes('"planner"') && !key.includes('"flowMap"') && !key.includes('"timers","heartbeat"');
}

export function useWorkspaceMutationGuard(): void {
  const count = useIsMutating({ predicate: mutation => holdsLayout(mutation.options.mutationKey) });
  useEffect(() => count > 0 ? beginWorkspaceTask() : undefined, [count]);
}
