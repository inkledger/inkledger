import { useEffect } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { beginWorkspaceTask } from "./client";

export function useWorkspaceMutationGuard(): void {
  const count = useIsMutating({
    predicate: mutation => {
      const key = JSON.stringify(mutation.options.mutationKey);
      return !key.includes('"workspace"') && !key.includes('"planner"') && !key.includes('"flowMap"');
    },
  });
  useEffect(() => count > 0 ? beginWorkspaceTask() : undefined, [count]);
}
