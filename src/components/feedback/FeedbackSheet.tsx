import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { ImagePlus, X } from "lucide-react";
import { FEEDBACK_BODY_MAX, FEEDBACK_SCREENSHOT_MAX_BYTES, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TITLE_MAX, FEEDBACK_TYPES, type FeedbackType } from "@contracts/feedback";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { useDirtyClose } from "@/components/app/DirtyClose";
import { surface } from "@/components/app/surface";
import { feedbackSheet, type FeedbackDraft } from "@/lib/flag";
import { errorText, toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { APP_BUILD_META } from "@contracts/appBuild";
import { t } from "@/i18n";
import { currentDensity, currentLook, typeLabel } from "./labels";
import { PICK_MAX_BYTES, shrinkScreenshot } from "./shrink";

/** "Send feedback", opened from the account menu, ⌘K or "Report" on an error (lib/flag.ts). */
export function FeedbackSheet() {
  const draft = feedbackSheet.use();
  const guard = useDirtyClose(() => feedbackSheet.set(null));
  return (
    <>
      {guard.confirm}
      <Dialog open={draft !== null} onOpenChange={guard.onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("pages.feedback.sheet.title")}</DialogTitle>
            <DialogDescription>{t("pages.feedback.sheet.description")}</DialogDescription>
          </DialogHeader>
          {/* Mounted only while open: every opening starts from its own draft. */}
          {draft !== null && <FeedbackForm draft={draft} onDirty={guard.markDirty} onDone={() => feedbackSheet.set(null)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

type Shot = { file: File; url: string };

function FeedbackForm({ draft, onDirty, onDone }: { draft: FeedbackDraft; onDirty: (dirty: boolean) => void; onDone: () => void }) {
  const id = useId();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  // The page it was opened from, as it was then (the sheet stays over it).
  const [page] = useState(() => pathname + search);
  const [look] = useState(currentLook);
  const [density] = useState(currentDensity);
  // The build the server records with it (the page's own, written at build time).
  const [build] = useState(() => document.querySelector<HTMLMetaElement>(`meta[name="${APP_BUILD_META}"]`)?.content ?? "dev");
  const [type, setType] = useState<FeedbackType>(draft.type ?? "problem");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(draft.body ?? "");
  const [shot, setShot] = useState<Shot | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [shareShot, setShareShot] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const access = trpc.feedback.access.useQuery(undefined, { staleTime: 60_000 });
  const utils = trpc.useUtils();
  const create = trpc.feedback.create.useMutation();
  const [busy, setBusy] = useState(false);

  useEffect(() => onDirty(title.trim() !== "" || body.trim() !== (draft.body ?? "").trim() || shot !== null), [title, body, shot, draft.body, onDirty]);
  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url);
  }, [shot]);

  // Made small enough to share (≤ 300 KB) here, in the browser, before anything is sent.
  const takeImage = async (picked: File | null | undefined) => {
    if (!picked) return;
    const file = (FEEDBACK_SCREENSHOT_TYPES as readonly string[]).includes(picked.type) && picked.size <= PICK_MAX_BYTES ? await shrinkScreenshot(picked) : null;
    if (!file || file.size > FEEDBACK_SCREENSHOT_MAX_BYTES) {
      setShotError(t("pages.feedback.sheet.screenshotBad"));
      return;
    }
    setShotError(null);
    setShot({ file, url: URL.createObjectURL(file) });
  };

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const sharing = share && access.data?.sharing === true;
      const made = await create.mutateAsync({ type, title: title.trim(), body, page, look, density, share: sharing, shareScreenshot: sharing && shareShot && shot !== null, screenshot: shot !== null });
      if (shot) {
        const form = new FormData();
        form.append("file", shot.file);
        const res = await fetch(`/api/feedback/${made.id}/screenshot`, { method: "POST", body: form, credentials: "same-origin" }).catch(() => null);
        if (!res?.ok) {
          const said = res ? ((await res.json().catch(() => null)) as { error?: string } | null)?.error : undefined;
          toast.error(t("pages.feedback.sheet.screenshotFailed", { error: said ?? t("ui.error.failed") }));
        }
      }
      await utils.feedback.invalidate();
      onDirty(false);
      onDone();
      toast.success(t("pages.feedback.sheet.sent"), { action: { label: t("pages.feedback.sheet.open"), onClick: () => void navigate(`/info/feedback/${made.id}`) } });
    } catch (e) {
      // What was typed stays: the sheet is still open.
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const contextRows: [string, string][] = [
    [t("pages.feedback.sheet.page"), page],
    [t("pages.feedback.sheet.version"), build],
    [t("pages.feedback.sheet.look"), look],
    [t("pages.feedback.sheet.density"), density],
  ];

  return (
    <form
      className="grid gap-4"
      onSubmit={e => {
        e.preventDefault();
        void submit();
      }}
      onPaste={e => {
        const item = [...e.clipboardData.items].find(i => i.kind === "file" && i.type.startsWith("image/"));
        if (!item) return;
        e.preventDefault();
        void takeImage(item.getAsFile());
      }}
    >
      <div className="grid gap-1.5">
        <span className="text-body-sm font-medium" id={`${id}-type`}>{t("pages.feedback.sheet.type")}</span>
        <SegmentedControl label={t("pages.feedback.sheet.type")} value={type} onChange={setType} options={FEEDBACK_TYPES.map(v => ({ value: v, label: typeLabel(v) }))} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-title`}>{t("pages.feedback.sheet.title_")}</Label>
        <Input id={`${id}-title`} value={title} maxLength={FEEDBACK_TITLE_MAX} required autoFocus placeholder={t("pages.feedback.sheet.titlePlaceholder")} onChange={e => setTitle(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-body`}>{t("pages.feedback.sheet.body")}</Label>
        <Textarea id={`${id}-body`} value={body} rows={5} maxLength={FEEDBACK_BODY_MAX} placeholder={t("pages.feedback.sheet.bodyPlaceholder")} onChange={e => setBody(e.target.value)} />
      </div>

      <div className="grid gap-1.5">
        <span className="text-body-sm font-medium">{t("pages.feedback.sheet.screenshot")}</span>
        {shot ? (
          <div className="flex items-start gap-3">
            <img src={shot.url} alt="" className="max-h-28 max-w-[12rem] rounded-md border object-contain" {...surface("picture")} />
            <Button type="button" variant="ghost" size="sm" onClick={() => setShot(null)}>
              <X className="mr-1.5 h-4 w-4" aria-hidden />
              {t("pages.feedback.sheet.screenshotRemove")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <ImagePlus className="mr-1.5 h-4 w-4" aria-hidden />
              {t("pages.feedback.sheet.screenshotPick")}
            </Button>
            <span className="text-caption text-muted-foreground">{t("pages.feedback.sheet.screenshotHint")}</span>
          </div>
        )}
        <input ref={fileRef} type="file" accept={FEEDBACK_SCREENSHOT_TYPES.join(",")} className="sr-only" tabIndex={-1} aria-hidden onChange={e => void takeImage(e.target.files?.[0])} />
        {shotError && (
          <p role="alert" className="text-caption text-danger">
            {shotError}
          </p>
        )}
      </div>

      <div className="grid gap-1 rounded-md bg-muted/60 px-3 py-2" {...surface("card")}>
        <span className="text-caption font-medium">{t("pages.feedback.sheet.context")}</span>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-caption">
          {contextRows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate">{v || "-"}</dd>
            </div>
          ))}
        </dl>
        <span className="text-caption text-muted-foreground">{t("pages.feedback.sheet.contextHint")}</span>
      </div>

      {access.data?.sharing && (
        <div className="grid gap-2">
          <label className="flex items-start gap-2 text-body-sm">
            <Checkbox className="mt-0.5" checked={share} onCheckedChange={v => setShare(v === true)} />
            <span>
              {t("pages.feedback.sheet.share")}
              <span className="block text-caption text-muted-foreground">{t("pages.feedback.sheet.shareHint")}</span>
            </span>
          </label>
          {share && shot && (
            <label className="ml-6 flex items-start gap-2 text-body-sm">
              <Checkbox className="mt-0.5" checked={shareShot} onCheckedChange={v => setShareShot(v === true)} />
              <span>{t("pages.feedback.sheet.shareScreenshot")}</span>
            </label>
          )}
        </div>
      )}

      {create.error && (
        <p role="alert" className="text-caption text-danger">
          {errorText(create.error)}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? t("pages.feedback.sheet.sending") : t("pages.feedback.sheet.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
