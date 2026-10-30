import { useState } from "react";
import { toast } from "sonner";
import { splitIdeas } from "@contracts/ideas";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toastError } from "@/lib/errorText";
import { MOD_KEY } from "@/lib/dom";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

/** One idea per line, a pasted list too (docs/work/ideas/triage.md R-2.2): Add or Mod+Enter puts them at the top of Raw. */
export function IdeaCapture({ containerId, autoFocus = false, onAdded }: { containerId?: number; autoFocus?: boolean; onAdded?: (count: number) => void }) {
  const [text, setText] = useState("");
  const utils = trpc.useUtils();
  const capture = trpc.ideas.capture.useMutation({
    onSuccess: made => {
      setText("");
      toast.success(t("pages.ideas.added", { count: made.length }));
      onAdded?.(made.length);
    },
    // What was typed stays: the error says why it wasn't kept.
    onError: e => toastError(e),
    onSettled: () => {
      void utils.ideas.list.invalidate();
      void utils.ideas.counts.invalidate();
    },
  });
  const count = splitIdeas(text).length;
  const add = () => {
    if (count > 0 && !capture.isPending) capture.mutate({ text, ...(containerId !== undefined ? { containerId } : {}) });
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <Textarea
        aria-label={t("pages.ideas.captureLabel")}
        placeholder={t("pages.ideas.capturePlaceholder")}
        value={text}
        autoFocus={autoFocus}
        rows={3}
        onChange={e => setText(e.currentTarget.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            add();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {count > 1 && (
          <span role="status" className="text-body-sm text-muted-foreground">
            {t("pages.ideas.preview", { count })}
          </span>
        )}
        <Button size="sm" disabled={count === 0 || capture.isPending} onClick={add} title={`${MOD_KEY} ↵`}>
          {t("pages.ideas.add")}
        </Button>
      </div>
    </div>
  );
}
