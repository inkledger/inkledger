import { lazy, Suspense, useRef, useState } from "react";
import { ArrowLeftRight, Download, FileUp, History, Lightbulb, MoreHorizontal, Radio, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Chip } from "@/components/app/Chip";
import { ActionRow } from "@/components/app/ActionRow";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/lib/workspace/context";
import { downloadBlob } from "@/lib/download";
import type { FlowMapDocument } from "@contracts/workspace/flowMap";
import type { Draft, ResolvedWorkspace, SuggestionPatch } from "@contracts/workspace/model";
import { dateFormat, t, type MessageKey } from "@/i18n";

const PlannerPanel = lazy(() => import("./PlannerPanel"));

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;
const savedAt = () => dateFormat({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The period the layers show, as far as files go: stored here, worked out on the fly, or imported. */
export type ShownPeriod = { kind: "stored"; evidenceId: string } | { kind: "live" } | { kind: "imported"; importId: string; document: FlowMapDocument } | null;

/**
 * The footer's left side: History (a sheet with every saved layout, to go back to) and More (the rest,
 * each behind its own step: suggestions, comparing periods, the files, usage collection, deletion).
 * Files download at once; an import's outcome is said in the footer's message slot.
 */
export function WorkspaceMore({ busy, shown, collectionOpen, onCollectionOpen, draft, onPatch, onRestore, onRollback, onError, onNotice }: {
  busy: boolean;
  shown: ShownPeriod;
  collectionOpen: boolean;
  onCollectionOpen: (open: boolean) => void;
  draft: Draft | null;
  onPatch: (patch: SuggestionPatch) => Promise<void>;
  onRestore: (draft: Draft, workspace: ResolvedWorkspace) => void;
  onRollback: (revisionId: string) => Promise<void>;
  onError: (message: unknown) => void;
  onNotice: (message: string) => void;
}) {
  const { scope, revisions } = useWorkspace();
  const utils = trpc.useUtils();
  const flow = trpc.flowMap.get.useQuery({ scope });
  const consent = trpc.flowMap.consent.useMutation();
  const aggregate = trpc.flowMap.aggregate.useMutation();
  const exportMap = trpc.flowMap.export.useMutation();
  const importMap = trpc.flowMap.import.useMutation();
  const deleteData = trpc.flowMap.delete.useMutation();
  const exportLayout = trpc.planner.export.useMutation();
  const importLayout = trpc.planner.import.useMutation();
  const [sheet, setSheet] = useState<"history" | "suggestions" | "compare" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const mapInput = useRef<HTMLInputElement>(null);
  const layoutInput = useRef<HTMLInputElement>(null);
  const working = busy || consent.isPending || aggregate.isPending || exportMap.isPending || importMap.isPending || deleteData.isPending || exportLayout.isPending || importLayout.isPending;
  const collecting = flow.data?.settings.enabled ?? false;

  const refresh = () => Promise.all([utils.flowMap.get.invalidate({ scope }), utils.flowMap.settings.invalidate(), utils.settings.get.invalidate()]);
  const run = async (action: () => Promise<void>) => {
    try { await action(); } catch (cause) { onError(cause); }
  };
  // The period on screen as a file: a stored one as it is, this week's saved first, an import as it came.
  const exportUsage = () => void run(async () => {
    if (shown?.kind === "imported") {
      downloadBlob(`import-${shown.importId}.flowmap`, new Blob([JSON.stringify(shown.document)], { type: "application/json" }));
      return;
    }
    const evidenceId = shown?.kind === "stored" ? shown.evidenceId : (await aggregate.mutateAsync({ scope })).evidenceId;
    const result = await exportMap.mutateAsync({ scope, evidenceId, view: "heat" });
    downloadBlob(result.filename, new Blob([result.contents], { type: "application/json" }));
    if (shown?.kind !== "stored") await refresh();
  });
  const exportWorkspace = () => void run(async () => {
    const result = await exportLayout.mutateAsync({ scope });
    downloadBlob(`workspace-${scope.surfaceId}.workspace`, new Blob([result.contents], { type: "application/json" }));
  });

  return (
    <>
      <Button variant="ghost" size="sm" aria-label={t(key("historyTitle"))} onClick={() => setSheet("history")}>
        <History className="h-4 w-4" /><span className="max-sm:sr-only">{t(key("historyTitle"))}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={t(key("moreOptions"))}>
            <MoreHorizontal className="h-4 w-4" /><span className="max-sm:sr-only">{t(key("moreShort"))}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64">
          <DropdownMenuItem onSelect={() => setSheet("suggestions")}><Lightbulb />{t(key("plannerTitle"))}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSheet("compare")}><ArrowLeftRight />{t(key("comparePeriods"))}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={working || !collecting} onSelect={() => void run(async () => {
            await aggregate.mutateAsync({ scope });
            await refresh();
            onNotice(t(key("periodsUpdated")));
          })}><RefreshCw />{t(key("generate"))}</DropdownMenuItem>
          <DropdownMenuItem disabled={working || shown === null && !collecting} onSelect={exportUsage}><Download />{t(key("exportMap"))}</DropdownMenuItem>
          <DropdownMenuItem disabled={working} onSelect={() => mapInput.current?.click()}><FileUp />{t(key("import"))}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={working} onSelect={exportWorkspace}><Download />{t(key("exportWorkspace"))}</DropdownMenuItem>
          <DropdownMenuItem disabled={working} onSelect={() => layoutInput.current?.click()}><FileUp />{t(key("importWorkspace"))}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onCollectionOpen(true)}>
            <Radio />{t(key("collectionTitle"))}
            <Chip tone={collecting ? "success" : "neutral"} className="ml-auto">{t(key(collecting ? "collectionOn" : "collectionOff"))}</Chip>
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={working} onSelect={() => setDeleting(true)}><Trash2 />{t(key("delete"))}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* The files' pickers, opened from More: out of the menu, so they outlive it. */}
      <input ref={mapInput} type="file" accept=".flowmap,application/json" className="sr-only" tabIndex={-1} aria-label={t(key("import"))} disabled={working} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void run(async () => {
          await importMap.mutateAsync({ contents: await file.text() });
          await refresh();
          onNotice(t(key("importedNotice")));
        });
      }} />
      <input ref={layoutInput} type="file" accept=".workspace,application/json" className="sr-only" tabIndex={-1} aria-label={t(key("importWorkspace"))} disabled={working} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void run(async () => {
          const result = await importLayout.mutateAsync({ scope, contents: await file.text() });
          if (result.preview) onRestore(result.preview.draft, result.preview.preview.workspace);
          onNotice(result.unknownContent ? t(key("unknownContent")) : t(key("importQuarantined")));
        });
      }} />

      <Sheet open={sheet === "history"} onOpenChange={open => setSheet(open ? "history" : null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t(key("historyTitle"))}</SheetTitle>
            <SheetDescription>{t(key("historyDescription"))}</SheetDescription>
          </SheetHeader>
          <div id="workspace-history" className="px-4 pb-4">
            {revisions.length === 0 ? <p className="text-body-sm text-muted-foreground">{t(key("noHistory"))}</p> : (
              <ul className="grid">
                {[{ revisionId: "default", committedAt: 0, changes: 0 }, ...revisions].map((revision, index, all) => {
                  const current = index === all.length - 1;
                  const name = revision.revisionId === "default"
                    ? t(key("historyDefault"))
                    : t(key("historyEntry"), { when: savedAt().format(revision.committedAt), count: revision.changes });
                  return (
                    <li key={revision.revisionId} className="border-b py-1.5 last:border-b-0">
                      <ActionRow
                        actions={current
                          ? <Chip tone="neutral">{t(key("historyCurrent"))}</Chip>
                          : <Button variant="ghost" size="sm" disabled={working} aria-label={`${t(key("rollback"))}: ${name}`} onClick={() => void onRollback(revision.revisionId).then(() => setSheet(null))}>{t(key("rollback"))}</Button>}
                      >
                        <span className="min-w-0 truncate text-body-sm tabular-nums">{name}</span>
                      </ActionRow>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={sheet === "suggestions" || sheet === "compare"} onOpenChange={open => { if (!open) setSheet(null); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t(key(sheet === "compare" ? "adaptationTitle" : "plannerTitle"))}</SheetTitle>
            <SheetDescription>{t(key(sheet === "compare" ? "adaptationDescription" : "plannerDescription"))}</SheetDescription>
          </SheetHeader>
          <div id="workspace-planner" className="px-4 pb-4">
            <Suspense fallback={null}>
              <PlannerPanel part={sheet === "compare" ? "compare" : "suggest"} draft={draft} onPatch={onPatch} onRestore={onRestore} />
            </Suspense>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={collectionOpen} onOpenChange={onCollectionOpen}>
        <DialogContent onOpenAutoFocus={event => {
          // Straight to the switch: that is what this dialog is for.
          event.preventDefault();
          document.querySelector<HTMLElement>("#workspace-flowmap [role='checkbox']")?.focus();
        }}>
          <DialogHeader>
            <DialogTitle>{t(key("collectionTitle"))}</DialogTitle>
            <DialogDescription>{t(key("flowDescription"))}</DialogDescription>
          </DialogHeader>
          <div id="workspace-flowmap" className="flex items-start gap-3">
            <Checkbox id="workspace-consent" aria-label={t(key("consent"))} aria-describedby="workspace-consent-hint" checked={collecting} disabled={working} className="mt-0.5" onCheckedChange={checked => void run(async () => {
              await consent.mutateAsync({ enabled: checked === true });
              await refresh();
            })} />
            <label htmlFor="workspace-consent" className="grid gap-1">
              <span className="text-body-sm font-medium">{t(key("consent"))}</span>
              <span id="workspace-consent-hint" className="text-caption text-muted-foreground">{t(key("consentHint"))}</span>
            </label>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t(key("delete"))}</AlertDialogTitle><AlertDialogDescription>{t(key("deleteDescription"))}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => void run(async () => { await deleteData.mutateAsync(); await refresh(); })}>{t(key("deleteConfirm"))}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
