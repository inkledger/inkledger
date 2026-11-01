import { createContext, useContext } from "react";
import type { Constraint, Draft, PresentationDescriptor, ResolvedWorkspace, Scope } from "@contracts/workspace/model";
import type { PendingActivation } from "@contracts/workspace/applyMachine";
import type { WorkspaceActions } from "./actions";

export type WorkspaceContextValue = {
  scope: Scope;
  workspace: ResolvedWorkspace;
  descriptor: PresentationDescriptor;
  history: readonly string[];
  /** The saved layouts, oldest first, as the Studio lists them. */
  revisions: readonly { revisionId: string; committedAt: number; changes: number }[];
  draft: Draft | null;
  draftDescriptor: PresentationDescriptor | null;
  draftWorkspace: ResolvedWorkspace | null;
  presentationStatus: "stable" | "pendingActivation" | "activationUncertain" | "unknown";
  pendingActivation: PendingActivation | null;
  constraints: readonly Constraint[];
  actions: WorkspaceActions;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceScopeProvider");
  return value;
}
