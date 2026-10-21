import { attachmentUrl } from "@/lib/attachments";
import { surface } from "@/components/app/surface";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
} from "lucide-react";
import { formatBytes } from "@/lib/initials";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export type ViewerAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
};

/** What the browser can show in the viewer (the server serves these inline). */
function previewKind(mime: string): "image" | "frame" | null {
  const type = mime.split(";")[0].trim().toLowerCase();
  if (
    [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/bmp",
    ].includes(type)
  )
    return "image";
  if (type === "application/pdf" || type === "text/plain") return "frame";
  return null;
}

/**
 * Attachments in a large dialog instead of a new tab: images and PDFs/text
 * previewed, anything else offered for download; ← → move between them.
 */
export function AttachmentViewer({
  items,
  index,
  onIndex,
  onClose,
  connectionId,
}: {
  items: ViewerAttachment[];
  /** The connection of the issue the attachments are on */
  connectionId?: number | null;
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const a = index !== null ? items[index] : undefined;
  const src = a ? attachmentUrl(a.id, "content", connectionId) : "";
  const kind = a ? previewKind(a.mimeType) : null;
  const go = (d: number) => {
    if (index === null || items.length < 2) return;
    onIndex((index + d + items.length) % items.length);
  };

  return (
    <Dialog open={!!a} onOpenChange={o => !o && onClose()}>
      <DialogContent
        className="flex h-[85vh] w-[calc(100vw-2rem)] max-w-5xl flex-col gap-3 p-4 sm:max-w-5xl"
        onKeyDown={e => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            go(1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            go(-1);
          }
        }}
      >
        {a && (
          <>
            <div className="flex min-w-0 items-center gap-2 pr-8">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-body font-semibold">
                  {a.filename}
                </DialogTitle>
                <DialogDescription className="text-caption">
                  {formatBytes(a.size)}
                  {items.length > 1 && ` · ${t("views.issue.viewer.position", { n: index! + 1, total: items.length })}`}
                </DialogDescription>
              </div>
              {items.length > 1 && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("views.issue.viewer.previous")}
                    onClick={() => go(-1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("views.issue.viewer.next")}
                    onClick={() => go(1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </>
              )}
              <Button variant="ghost" size="icon-sm" asChild>
                <a
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("views.issue.viewer.newTab")}
                  title={t("views.issue.viewer.newTab")}
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
            <div {...surface("ground")} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted">
              {kind === "image" ? (
                <img
                  src={src}
                  alt={a.filename}
                  className="max-h-full max-w-full object-contain"
                />
              ) : kind === "frame" ? (
                <iframe
                  key={a.id}
                  src={src}
                  title={a.filename}
                  className="h-full w-full rounded-lg bg-card"
                />
              ) : (
                <div className="grid justify-items-center gap-3 p-6 text-center">
                  <p className="text-body-sm text-muted-foreground">
                    {t("views.issue.viewer.noPreview")}
                  </p>
                  <Button asChild>
                    <a href={src} download={a.filename}>
                      <Download className="h-4 w-4" /> {t("views.issue.viewer.download")}
                    </a>
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
