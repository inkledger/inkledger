import {
  Bold,
  Code2,
  Eye,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Pencil,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Save,
  Sparkles,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { MarkdownCommand } from "./markdownEdit";

const commands: {
  command: MarkdownCommand;
  icon: typeof Bold;
  label: string;
}[] = [
  { command: "bold", icon: Bold, label: t("pages.notes.bold") },
  { command: "italic", icon: Italic, label: t("pages.notes.italic") },
  { command: "strike", icon: Strikethrough, label: t("pages.notes.strike") },
  { command: "code", icon: Code2, label: t("pages.notes.inlineCode") },
  { command: "heading", icon: Heading3, label: t("pages.notes.heading") },
  { command: "quote", icon: Quote, label: t("pages.notes.quote") },
  { command: "bullets", icon: List, label: t("pages.notes.bullets") },
  { command: "numbers", icon: ListOrdered, label: t("pages.notes.numbers") },
  { command: "tasks", icon: ListTodo, label: t("pages.notes.tasks") },
  { command: "codeBlock", icon: SquareCode, label: t("pages.notes.codeBlock") },
  { command: "link", icon: Link2, label: t("pages.notes.link") },
];

export function MarkdownToolbar({
  apply,
  undo,
  redo,
  canUndo,
  canRedo,
  preview,
  togglePreview,
  onSave,
  saving,
  dirty,
  disabled,
  onTidy,
  tidying = false,
}: {
  apply: (command: MarkdownCommand) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  preview: boolean;
  togglePreview: () => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
  disabled?: boolean;
  /** "Tidy up with AI": a copy of the note beside it (nothing changes until it is kept). */
  onTidy?: () => void;
  tidying?: boolean;
}) {
  return (
    <div
      role="toolbar"
      aria-label={t("pages.notes.toolbar")}
      className="flex flex-wrap items-center gap-0.5 border-b px-3 py-2"
    >
      {!preview &&
        commands.map(({ command, icon: Icon, label }) => (
          <Button
            key={command}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            disabled={disabled}
            onMouseDown={event => event.preventDefault()}
            onClick={() => apply(command)}
          >
            <Icon aria-hidden />
          </Button>
        ))}
      <div className="mx-1 h-5 w-px bg-border" aria-hidden />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("pages.notes.undo")}
        title={t("pages.notes.undo")}
        disabled={preview || !canUndo}
        onClick={undo}
      >
        <Undo2 />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("pages.notes.redo")}
        title={t("pages.notes.redo")}
        disabled={preview || !canRedo}
        onClick={redo}
      >
        <Redo2 />
      </Button>
      {onTidy && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || tidying}
          onMouseDown={event => event.preventDefault()}
          onClick={onTidy}
          title={t("pages.notes.ai.tidyTip")}
        >
          <Sparkles />
          {tidying ? t("pages.notes.ai.tidying") : t("pages.notes.ai.tidy")}
        </Button>
      )}
      <Button
        type="button"
        size="sm"
        className="ml-auto"
        disabled={disabled || saving || !dirty}
        onMouseDown={event => event.preventDefault()}
        onClick={onSave}
        title={t("pages.notes.saveTip")}
      >
        <Save />
        {saving ? t("pages.notes.saving") : t("pages.notes.save")}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-pressed={preview}
        onMouseDown={event => event.preventDefault()}
        onClick={togglePreview}
      >
        {preview ? <Pencil /> : <Eye />}
        {preview ? t("pages.notes.edit") : t("pages.notes.preview")}
      </Button>
    </div>
  );
}
