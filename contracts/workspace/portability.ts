import type { ActiveRevision, DiscoveryState, Draft, FeedbackState, Scope } from "./model";
import type { CANONICALIZATION_VERSION } from "./versions";

export const WORKSPACE_FORMAT_VERSION = 1;
export type WorkspaceDocument = {
  format: "workspace";
  version: typeof WORKSPACE_FORMAT_VERSION;
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
  exportedAt: number;
  scope: Scope;
  revision: ActiveRevision;
  draft: Draft | null;
  feedback: FeedbackState;
  discovery: DiscoveryState;
  checksum: string;
};
