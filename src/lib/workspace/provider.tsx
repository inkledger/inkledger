import { useMemo, type ReactNode } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { CATALOG_V1, PRODUCT_DEFAULTS_V1 } from "@contracts/workspace/catalogV1";
import { productDefaultFor } from "@contracts/workspace/catalog";
import type { PresentationDescriptor, ResolvedWorkspace, Scope } from "@contracts/workspace/model";
import { workspaceClientInstanceId } from "./client";
import { useWorkspaceActions } from "./actions";
import { WorkspaceContext, type WorkspaceContextValue } from "./context";
import { useWorkspaceTelemetry } from "./telemetry";
import { useWorkspaceMutationGuard } from "./mutationGuard";

function fallbackWorkspace(scope: Scope): ResolvedWorkspace {
  const productDefault = productDefaultFor(PRODUCT_DEFAULTS_V1, scope.surfaceId);
  return {
    scope,
    sourceActiveRevision: "default",
    catalogVersion: CATALOG_V1.catalogVersion,
    productDefaultVersion: productDefault.productDefaultVersion,
    resolverVersion: CATALOG_V1.resolverVersion,
    placements: productDefault.placements.map(placement => ({ ...placement, origin: "product" })),
    fallbacks: [],
    discoveryAnchorIds: [],
    discoveryAreaIds: [],
    opaque: [],
  };
}

function fallbackDescriptor(workspace: ResolvedWorkspace): PresentationDescriptor {
  return {
    effectiveRevision: `default_${workspace.scope.surfaceId}_${workspace.scope.deviceClass}`,
    sourceActiveRevision: "default",
    workspaceFingerprint: "default",
    productDefaultVersion: workspace.productDefaultVersion,
    catalogVersion: workspace.catalogVersion,
    resolverVersion: workspace.resolverVersion,
    constraintsFingerprint: "default",
    feedbackFingerprint: "default",
    discoveryFingerprint: "default",
    rendererBindingsFingerprint: "default",
  };
}

/**
 * The layout of one scope. Who never committed a layout there and has FlowMap off gets the
 * bundled ProductDefault with no request at all; `live` (the Studio) always asks the server.
 */
export function WorkspaceScopeProvider({ scope: requestedScope, children, telemetry = true, live = false }: { scope: Scope; children: ReactNode; telemetry?: boolean; live?: boolean }) {
  const scope = useMemo(() => ({ surfaceId: requestedScope.surfaceId, deviceClass: requestedScope.deviceClass }), [requestedScope.surfaceId, requestedScope.deviceClass]);
  const clientInstanceId = useMemo(() => workspaceClientInstanceId(), []);
  const utils = trpc.useUtils();
  const usage = trpc.settings.get.useQuery(undefined, { select: settings => settings.workspace });
  const flowMap = usage.data?.flowMap === true;
  const enabled = live || flowMap || (usage.data?.scopes.includes(`${scope.surfaceId}:${scope.deviceClass}`) ?? false);
  const initialData = useMemo(() => utils.workspace.get.getData({ scope, clientInstanceId: "ssr" }), [utils, scope]);
  const query = trpc.workspace.get.useQuery({ scope, clientInstanceId }, {
    enabled,
    initialData,
    placeholderData: keepPreviousData,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const actions = useWorkspaceActions(scope, clientInstanceId);
  const descriptor = query.data?.descriptor;
  const presentation = query.data?.presentation?.presented;
  useWorkspaceMutationGuard();
  useWorkspaceTelemetry(scope, clientInstanceId, descriptor, presentation, telemetry && flowMap);
  const value = useMemo<WorkspaceContextValue>(() => {
    const workspace = query.data?.workspace ?? fallbackWorkspace(scope);
    return {
      scope,
      workspace,
      descriptor: query.data?.descriptor ?? fallbackDescriptor(workspace),
      history: query.data?.history ?? [],
      revisions: query.data?.revisions ?? [],
      draft: query.data?.draft ?? null,
      draftDescriptor: query.data?.draftDescriptor ?? null,
      draftWorkspace: query.data?.draftWorkspace ?? null,
      presentationStatus: query.data?.presentation?.status ?? "stable",
      pendingActivation: query.data?.presentation?.pending ?? null,
      constraints: query.data?.constraints ?? [],
      actions,
    };
  }, [actions, query.data, scope]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
