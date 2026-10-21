import { attachmentUrl } from "@/lib/attachments";
import { surface, surfaceFace } from "@/components/app/surface";
import { useId, useRef, useState } from "react";
import {
  File as FileIcon,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Paperclip,
  Upload,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatDate } from "@contracts/time";
import { formatBytes } from "@/lib/initials";
import { useAttachmentUpload } from "@/hooks/useAttachmentUpload";
import { EmptyState, ErrorState } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Meter } from "@/components/app/Meter";
import { AttachmentViewer } from "@/components/issue/AttachmentViewer";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";

function iconFor(mime: string) {
  if (mime.includes("pdf") || mime.startsWith("text/")) return FileText;
  if (mime.includes("sheet") || mime.includes("excel") || mime.includes("csv"))
    return FileSpreadsheet;
  if (mime.includes("zip") || mime.includes("compressed")) return FileArchive;
  return FileIcon;
}

/** Jira attachments: thumbnails, download through the server, drag & drop upload. */
export function AttachmentsSection({ issueKey, connectionId }: { issueKey: string; connectionId?: number | null }) {
  const provider = useProviderName(connectionId);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const utils = trpc.useUtils();
  const list = trpc.issues.attachments.useQuery(
    { key: issueKey },
    { retry: false }
  );
  const { progress, error, upload } = useAttachmentUpload(
    issueKey,
    () => {
      toast.success(t("views.issue.attachments.uploaded", { provider }));
      void utils.issues.attachments.invalidate({ key: issueKey });
    },
    connectionId
  );

  const send = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    await upload([...files]);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="grid gap-4">
      <div
        {...surface("glass")}
        onDragOver={e => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          void send(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center gap-2 rounded-xl border border-dashed p-4 text-center text-body-sm transition-colors",
          dragging ? "border-primary-strong bg-primary-soft" : "bg-background"
        )}
      >
        <Upload className="h-5 w-5 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground">
          {t("views.issue.attachments.dropHint")}
        </p>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          className="sr-only"
          onChange={e => void send(e.target.files)}
        />
        <Button
          asChild
          variant="outline"
          size="sm"
          disabled={progress !== null}
        >
          <label htmlFor={inputId} className="cursor-pointer">
            {t("views.issue.attachments.choose")}
          </label>
        </Button>
        {progress !== null && (
          <div
            className="w-full max-w-xs"
            role="progressbar"
            aria-label={t("views.issue.attachments.uploading")}
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <Meter value={progress} max={100} animate lit />
            <p className="mt-1 text-caption text-muted-foreground tabular">
              {progress}%
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}
      </div>

      {list.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map(n => (
            <Skeleton key={n} className="h-32" />
          ))}
        </div>
      ) : list.error ? (
        <ErrorState
          message={list.error.message}
          onRetry={() => list.refetch()}
        />
      ) : list.data.length === 0 ? (
        <EmptyState icon={Paperclip} title={t("views.issue.attachments.empty")} className="py-6" />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {list.data.map((a, index) => {
            const Icon = iconFor(a.mimeType);
            const isImage = a.mimeType.startsWith("image/") && a.hasThumbnail;
            return (
              <li key={a.id} {...surface("card", { role: "wrap" })} className="rounded-xl">
                <button
                  {...surfaceFace()}
                  type="button"
                  onClick={() => setViewing(index)}
                  aria-label={t("views.issue.attachments.open", { name: a.filename })}
                  className="group block w-full overflow-hidden rounded-xl border bg-card text-left outline-none transition-shadow hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <div className="flex h-24 items-center justify-center overflow-hidden bg-muted">
                    {isImage ? (
                      <img
                        src={attachmentUrl(a.id, "thumbnail", connectionId)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                      />
                    ) : (
                      <Icon
                        className="h-8 w-8 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                  </div>
                  <div className="p-2.5">
                    <p
                      className="truncate text-body-sm font-medium"
                      title={a.filename}
                    >
                      {a.filename}
                    </p>
                    <p className="truncate text-caption text-muted-foreground">
                      {formatBytes(a.size)}
                      {a.created && ` · ${formatDate(new Date(a.created), "short")}`}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <AttachmentViewer
        connectionId={connectionId}
        items={list.data ?? []}
        index={viewing}
        onIndex={setViewing}
        onClose={() => setViewing(null)}
      />
    </div>
  );
}
