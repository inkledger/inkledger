import { useId, useRef, useState } from "react";
import { ImagePlus, Link2 } from "lucide-react";
import type { RichDoc } from "@contracts/richtext";
import { ideaFileUrl } from "@contracts/ideaFiles";
import { RichText } from "@/components/app/RichText";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { applyMarkdown } from "@/components/notes/markdownEdit";
import { toastError } from "@/lib/errorText";
import { t } from "@/i18n";

/** An idea's own pictures, served by the app; any other image stays a link. */
const ideaImage = ({ url }: { url?: string }) => {
  const m = url ? /^idea-file:(\d+)$/.exec(url) : null;
  return m ? ideaFileUrl(Number(m[1])) : null;
};

async function upload(ideaId: number, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/ideas/${ideaId}/files`, { method: "POST", body: form, credentials: "same-origin" });
  const answer = (await res.json().catch(() => ({}))) as { markdown?: string; error?: string };
  if (!res.ok || !answer.markdown) throw new Error(answer.error ?? t("pages.ideas.imageFailed"));
  return answer.markdown;
}

const imagesOf = (list: FileList | null | undefined) => [...(list ?? [])].filter(f => f.type.startsWith("image/"));

/**
 * The idea's text in Markdown: links and pictures (pasted, dropped, or added
 * with the button: on a phone the camera or the gallery), shown drawn in
 * Preview. Saved when left, as every field of the idea.
 */
export function IdeaBody({
  ideaId,
  body,
  setBody,
  save,
  doc,
  saved,
}: {
  ideaId: number;
  body: string;
  setBody: (body: string) => void;
  save: (body: string) => void;
  /** The saved text, drawn by the server */
  doc: RichDoc;
  /** Whether what is typed is what `doc` shows */
  saved: boolean;
}) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<"write" | "preview">("write");
  const [busy, setBusy] = useState(false);

  /** Pictures in at the caret (where the text was being written), then saved. */
  const addImages = async (files: File[]) => {
    if (!files.length) return;
    const el = area.current;
    // At the caret while writing there; at the end otherwise (the button, a drop on a field not in use).
    const at = el && document.activeElement === el ? { start: el.selectionStart, end: el.selectionEnd } : { start: body.length, end: body.length };
    setBusy(true);
    try {
      const made: string[] = [];
      for (const f of files) made.push(await upload(ideaId, f));
      const insert = `${at.start > 0 && body[at.start - 1] !== "\n" ? "\n" : ""}${made.join("\n")}\n`;
      const next = body.slice(0, at.start) + insert + body.slice(at.end);
      setBody(next);
      save(next);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const link = () => {
    const el = area.current;
    if (!el) return;
    const edit = applyMarkdown(body, { start: el.selectionStart, end: el.selectionEnd }, "link");
    setBody(edit.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(edit.start, edit.end);
    });
  };

  return (
    <div className="grid gap-1.5 text-body-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="font-medium">
          {t("pages.ideas.problem")}
        </label>
        <div className="flex flex-wrap items-center gap-1">
          {view === "write" && (
            <>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("pages.ideas.addLink")} title={t("pages.ideas.addLink")} onMouseDown={e => e.preventDefault()} onClick={link}>
                <Link2 />
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onMouseDown={e => e.preventDefault()} onClick={() => picker.current?.click()}>
                <ImagePlus />
                {busy ? t("pages.ideas.imageUploading") : t("pages.ideas.addImage")}
              </Button>
              <input
                ref={picker}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                onChange={e => {
                  void addImages(imagesOf(e.currentTarget.files));
                  e.currentTarget.value = "";
                }}
              />
            </>
          )}
          <SegmentedControl
            label={t("pages.ideas.textView")}
            value={view}
            onChange={next => {
              // The preview is the saved text: what was typed is saved first.
              if (next === "preview" && !saved) save(body);
              setView(next);
            }}
            options={[
              { value: "write", label: t("pages.ideas.write") },
              { value: "preview", label: t("pages.ideas.textPreview") },
            ]}
          />
        </div>
      </div>
      {view === "write" ? (
        <Textarea
          id={id}
          ref={area}
          rows={6}
          value={body}
          onChange={e => setBody(e.currentTarget.value)}
          onBlur={() => !saved && save(body)}
          onPaste={e => {
            const files = imagesOf(e.clipboardData.files);
            if (!files.length) return;
            e.preventDefault();
            void addImages(files);
          }}
          onDragOver={e => {
            if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
          }}
          onDrop={e => {
            const files = imagesOf(e.dataTransfer.files);
            if (!files.length) return;
            e.preventDefault();
            void addImages(files);
          }}
          aria-describedby={`${id}-hint`}
        />
      ) : (
        <div id={id} className="min-h-24 rounded-md border px-3 py-2">
          <RichText doc={doc} images={new Map()} variant="document" headingLevel={3} resolveImage={ideaImage} />
        </div>
      )}
      <p id={`${id}-hint`} className="text-caption text-muted-foreground">
        {t("pages.ideas.textHint")}
      </p>
    </div>
  );
}
