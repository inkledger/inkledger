import { useState } from "react";
import { useNavigate } from "react-router";
import type { NoteDocument } from "@contracts/notes";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";
import { toastError } from "@/lib/errorText";

export function ConflictBanner({
  current,
  title,
  body,
  busy,
  useServer,
  saveCopy,
  overwrite,
}: {
  current: NoteDocument;
  title: string;
  body: string;
  busy: boolean;
  useServer: () => void;
  saveCopy: () => Promise<NoteDocument>;
  overwrite: () => Promise<NoteDocument | null>;
}) {
  const [compare, setCompare] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [copying, setCopying] = useState(false);
  const navigate = useNavigate();
  return (
    <section
      role="alert"
      className="grid gap-3 border-b border-warning/40 bg-warning-soft px-4 py-3 text-body-sm"
    >
      <div>
        <p className="font-medium">{t("pages.notes.conflictTitle")}</p>
        <p className="text-muted-foreground">{t("pages.notes.conflictText")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCompare(value => !value)}
          aria-expanded={compare}
        >
          {t("pages.notes.compare")}
        </Button>
        <Button size="sm" variant="outline" onClick={useServer}>
          {t("pages.notes.useServer")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || copying || (!title.trim() && !body.trim())}
          onClick={() => {
            setCopying(true);
            void saveCopy()
              .then(note => navigate(`/notes/${note.id}`))
              .catch(toastError)
              .finally(() => setCopying(false));
          }}
        >
          {t("pages.notes.saveCopy")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => setConfirm(true)}
        >
          {t("pages.notes.overwrite")}
        </Button>
      </div>
      {compare && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-1 font-medium">{t("pages.notes.myVersion")}</h3>
            <pre
              {...surface("nav", { edge: false })}
              className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-caption"
            >{`${title}\n\n${body}`}</pre>
          </div>
          <div className="min-w-0">
            <h3 className="mb-1 font-medium">
              {t("pages.notes.serverVersion")}
            </h3>
            <pre
              {...surface("nav", { edge: false })}
              className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-caption"
            >{`${current.title}\n\n${current.body}`}</pre>
          </div>
        </div>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("pages.notes.overwriteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.notes.overwriteText")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => void overwrite().catch(toastError)}
            >
              {t("pages.notes.overwriteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
