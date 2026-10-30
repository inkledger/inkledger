import { useId, useState } from "react";
import { toast } from "sonner";
import { Check, ClipboardCopy, RotateCcw, Sparkles, X } from "lucide-react";
import { tidyInstructions, tidyMissing } from "@contracts/noteTidy";
import { currentLocale } from "@contracts/i18n/core";
import { trpc } from "@/lib/trpc";
import { copyText } from "@/lib/issues";
import { toastError } from "@/lib/errorText";
import { dateFormat, t } from "@/i18n";
import { RichText } from "@/components/app/RichText";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { Chip } from "@/components/app/Chip";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { NoteDocumentController } from "./useNoteDocument";
import type { NoteAi } from "./useNoteAi";

/** Original | AI, above the note, while a copy waits. */
export function NoteAiSwitch({ state }: { state: NoteAi }) {
  if (!state.ai) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <SegmentedControl
        label={t("pages.notes.ai.versions")}
        value={state.view}
        onChange={state.setView}
        options={[
          { value: "original", label: t("pages.notes.ai.original") },
          { value: "ai", label: t("pages.notes.ai.aiCopy"), icon: Sparkles },
        ]}
      />
      {state.ai.stale && (
        <Chip tone="warning">{t("pages.notes.ai.stale")}</Chip>
      )}
    </div>
  );
}

/** The AI's copy, read-only: keep it, discard it, make it again, or compare. */
export function NoteAiView({
  controller,
  state,
}: {
  controller: NoteDocumentController;
  state: NoteAi;
}) {
  const utils = trpc.useUtils();
  const [compare, setCompare] = useState(false);
  const keep = trpc.notes.keepAi.useMutation();
  const discard = trpc.notes.discardAi.useMutation();
  const ai = state.ai;
  const id = controller.currentId;
  if (!ai || !id) return null;
  const missing = tidyMissing(controller.body, ai.body);
  const busy = keep.isPending || discard.isPending || state.tidying;

  const keepIt = async () => {
    const saved = await controller.flush();
    const revision = (saved ?? controller.note)?.contentRevision;
    if (controller.getConflict() || !revision) return;
    try {
      const result = await keep.mutateAsync({ id, expectedRevision: revision });
      if (result.status === "conflict") {
        controller.reportConflict(result.current);
        return;
      }
      controller.applyRestored(result.note);
      state.set(null);
      void utils.notes.versions.invalidate({ id });
      const versionId = result.versionId;
      toast.success(t("pages.notes.ai.kept"), {
        action: versionId
          ? {
              label: t("pages.notes.undo"),
              onClick: () =>
                void utils.client.notes.restoreVersion
                  .mutate({
                    id,
                    versionId,
                    expectedRevision: result.note.contentRevision,
                  })
                  .then(back =>
                    back.status === "updated"
                      ? controller.applyRestored(back.note)
                      : controller.reportConflict(back.current)
                  )
                  .catch(toastError),
            }
          : undefined,
      });
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <article
      className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6"
      aria-label={t("pages.notes.ai.aiCopy")}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void keepIt()}>
          <Check />
          {t("pages.notes.ai.keep")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            discard
              .mutateAsync({ id })
              .then(() => state.set(null))
              .catch(toastError)
          }
        >
          <X />
          {t("pages.notes.ai.discard")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void state.run()}
        >
          <RotateCcw />
          {state.tidying
            ? t("pages.notes.ai.tidying")
            : t("pages.notes.ai.redo")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="sm:ml-auto"
          aria-pressed={compare}
          onClick={() => setCompare(!compare)}
        >
          {t("pages.notes.ai.compare")}
        </Button>
      </div>
      {ai.createdAt && (
        <p className="mb-2 text-caption text-muted-foreground">
          {t("pages.notes.ai.madeAt", {
            time: dateFormat({ dateStyle: "short", timeStyle: "short" }).format(
              new Date(ai.createdAt)
            ),
          })}
        </p>
      )}
      {missing.length > 0 && (
        <p
          role="note"
          className="mb-3 text-body-sm text-warning [overflow-wrap:anywhere]"
        >
          {t("pages.notes.ai.missing", {
            items: missing.slice(0, 12).join(", "),
          })}
        </p>
      )}
      {compare ? (
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          {[
            { label: t("pages.notes.ai.original"), text: controller.body },
            { label: t("pages.notes.ai.aiCopy"), text: ai.body },
          ].map(side => (
            <section key={side.label} className="min-w-0">
              <h3 className="mb-1 text-caption font-medium text-muted-foreground">
                {side.label}
              </h3>
              <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-body-sm [overflow-wrap:anywhere]">
                {side.text}
              </pre>
            </section>
          ))}
        </div>
      ) : (
        <RichText
          doc={ai.doc}
          images={new Map()}
          variant="document"
          headingLevel={2}
        />
      )}
    </article>
  );
}

/** No local model (or a note too long for one): the note for any model, its answer pasted back. */
export function TidyByHandDialog({
  controller,
  state,
}: {
  controller: NoteDocumentController;
  state: NoteAi;
}) {
  const id = useId();
  const [pasted, setPasted] = useState("");
  const setAi = trpc.notes.setAi.useMutation();
  const noteId = controller.currentId;
  const close = (open: boolean) => {
    state.setByHand(open);
    if (!open) setPasted("");
  };
  return (
    <Dialog open={state.byHand} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pages.notes.ai.byHandTitle")}</DialogTitle>
          <DialogDescription>
            {t("pages.notes.ai.byHandText")}
          </DialogDescription>
        </DialogHeader>
        <Button
          variant="outline"
          onClick={() =>
            void copyText(
              `${tidyInstructions(currentLocale())}\n\n---\n\n${controller.title ? `Title: ${controller.title}\n\n` : ""}${controller.body}`
            ).then(ok =>
              ok
                ? toast.success(t("pages.notes.ai.copied"))
                : toast.error(t("ui.issueActions.copyFailed"))
            )
          }
        >
          <ClipboardCopy />
          {t("pages.notes.ai.copyForModel")}
        </Button>
        <label htmlFor={id} className="text-body-sm font-medium">
          {t("pages.notes.ai.paste")}
        </label>
        <Textarea
          id={id}
          rows={8}
          value={pasted}
          onChange={event => setPasted(event.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!pasted.trim() || !noteId || setAi.isPending}
            onClick={() =>
              noteId &&
              setAi
                .mutateAsync({ id: noteId, markdown: pasted.trim() })
                .then(note => {
                  state.set(note.ai);
                  close(false);
                })
                .catch(toastError)
            }
          >
            {t("pages.notes.ai.usePasted")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
