import { useCallback, useState } from "react";
import { useSearchParams } from "react-router";
import { NOTE_BODY_MAX, NOTE_TITLE_MAX } from "@contracts/notes";
import { RichText } from "@/components/app/RichText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { MarkdownToolbar } from "./MarkdownToolbar";
import { ConflictBanner } from "./ConflictBanner";
import { applyMarkdown } from "./markdownEdit";
import { useMarkdownHistory } from "./useMarkdownHistory";
import type { NoteDocumentController } from "./useNoteDocument";

export function NoteEditor({
  controller,
}: {
  controller: NoteDocumentController;
}) {
  const [viewParams, setViewParams] = useSearchParams();
  const view = viewParams.get("view");
  const preview = view ? view === "preview" : !!controller.currentId;
  const setPreview = (next: boolean) => {
    setViewParams(
      previous => {
        const params = new URLSearchParams(previous);
        params.set("view", next ? "preview" : "edit");
        return params;
      },
      { replace: true }
    );
  };
  const [stalePreview, setStalePreview] = useState(false);
  const {
    area,
    input,
    undo,
    redo,
    canUndo,
    canRedo,
    apply: applyHistory,
    commit,
    compositionStart,
    compositionEnd,
  } = useMarkdownHistory(controller.body, controller.setBody);

  const apply = useCallback(
    (command: Parameters<typeof applyMarkdown>[2]) => {
      const element = area.current;
      if (!element) return;
      const next = applyMarkdown(
        controller.body,
        { start: element.selectionStart, end: element.selectionEnd },
        command
      );
      applyHistory(next.value, { start: next.start, end: next.end });
    },
    [applyHistory, area, controller.body]
  );

  const saveAndPreview = async () => {
    commit();
    const saved = await controller.flush();
    if (controller.getConflict()) {
      setPreview(false);
      return;
    }
    setPreview(true);
    const offline =
      typeof navigator !== "undefined" && navigator.onLine === false;
    setStalePreview(offline || !controller.isCurrent(saved));
  };

  const togglePreview = async () => {
    if (preview) setPreview(false);
    else await saveAndPreview();
  };

  const keyDown = (event: React.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      void saveAndPreview();
    } else if (!preview && key === "b") {
      event.preventDefault();
      apply("bold");
    } else if (!preview && key === "i") {
      event.preventDefault();
      apply("italic");
    } else if (!preview && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (!preview && key === "y") {
      event.preventDefault();
      redo();
    }
  };

  const confirmed = controller.note;
  const hasSource = controller.body.trim().length > 0;
  const rendered =
    confirmed && confirmed.doc.blocks.length > 0 ? confirmed.doc : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={keyDown}>
      {controller.recovery && (
        <div
          className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-3 text-body-sm"
          role="status"
        >
          <span className="min-w-0 flex-1">
            {t("pages.notes.recoveryText")}
          </span>
          <Button size="sm" variant="outline" onClick={controller.recover}>
            {t("pages.notes.recover")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={controller.discardRecovery}
          >
            {t("pages.notes.discardDraft")}
          </Button>
        </div>
      )}
      {controller.conflict && (
        <ConflictBanner
          current={controller.conflict}
          title={controller.title}
          body={controller.body}
          busy={controller.busy}
          useServer={controller.useServer}
          saveCopy={controller.saveCopy}
          overwrite={controller.overwrite}
        />
      )}
      {controller.error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-body-sm text-danger"
        >
          <span className="min-w-0 flex-1">{controller.error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void controller.flush()}
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      <MarkdownToolbar
        apply={apply}
        undo={undo}
        redo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        preview={preview}
        togglePreview={() => void togglePreview()}
        onSave={() => void saveAndPreview()}
        saving={controller.status === "saving"}
        dirty={controller.dirty}
        disabled={!!controller.conflict}
      />
      {!preview ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 md:p-6">
          <div>
            <label htmlFor="note-title" className="sr-only">
              {t("pages.notes.noteTitle")}
            </label>
            <Input
              id="note-title"
              value={controller.title}
              maxLength={NOTE_TITLE_MAX}
              onChange={event => controller.setTitle(event.target.value)}
              onBlur={() => void controller.flush()}
              placeholder={t("pages.notes.untitled")}
              className="h-auto border-0 px-0 py-1 font-display text-title shadow-none focus-visible:ring-0 md:text-title"
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1">
            <label htmlFor="note-body" className="sr-only">
              {t("pages.notes.markdown")}
            </label>
            <Textarea
              id="note-body"
              ref={area}
              value={controller.body}
              maxLength={NOTE_BODY_MAX}
              onChange={input}
              onCompositionStart={compositionStart}
              onCompositionEnd={compositionEnd}
              onBlur={() => {
                commit();
                void controller.flush();
              }}
              placeholder={t("pages.notes.bodyPlaceholder")}
              className="min-h-[45dvh] w-full flex-1 resize-none border-0 px-0 py-1 leading-relaxed shadow-none focus-visible:ring-0 lg:min-h-0"
            />
            <span className="text-right text-caption text-muted-foreground">
              {controller.body.length} / {NOTE_BODY_MAX}
            </span>
          </div>
        </div>
      ) : (
        <article
          className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6"
          aria-label={t("pages.notes.preview")}
        >
          <h2 className="font-display text-title">
            {controller.title || t("pages.notes.untitled")}
          </h2>
          {stalePreview && (
            <p className="mt-2 text-body-sm text-warning">
              {t("pages.notes.stalePreview")}
            </p>
          )}
          {rendered ? (
            <RichText
              doc={rendered}
              images={new Map()}
              variant="document"
              headingLevel={2}
            />
          ) : hasSource ? (
            <>
              <p className="mt-3 text-body-sm text-warning" role="alert">
                {t("pages.notes.previewUnavailable")}
              </p>
              <pre className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-3 text-body-sm [overflow-wrap:anywhere]">
                {controller.body}
              </pre>
            </>
          ) : (
            <p className="mt-3 text-body-sm text-muted-foreground">
              {t("pages.notes.emptyDocument")}
            </p>
          )}
          <div className="mt-4">
            <MarkdownGuide />
          </div>
        </article>
      )}
      {!preview && (
        <div className="flex justify-end border-t px-4 py-2">
          <MarkdownGuide />
        </div>
      )}
    </div>
  );
}

function MarkdownGuide() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          {t("pages.notes.markdownGuide")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pages.notes.guideTitle")}</DialogTitle>
          <DialogDescription>{t("pages.notes.guideText")}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-body-sm">
          <dt>**{t("pages.notes.bold")}**</dt>
          <dd>{t("pages.notes.guideInline")}</dd>
          <dt>### {t("pages.notes.heading")}</dt>
          <dd>{t("pages.notes.guideBlocks")}</dd>
          <dt>- [ ] {t("pages.notes.tasks")}</dt>
          <dd>{t("pages.notes.guideLists")}</dd>
          <dt>[{t("pages.notes.link")}](https://…)</dt>
          <dd>{t("pages.notes.guideLinks")}</dd>
        </dl>
      </DialogContent>
    </Dialog>
  );
}
