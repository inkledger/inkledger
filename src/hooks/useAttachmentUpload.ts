import { useState } from "react";
import { t } from "@/i18n";

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

type UploadState = { progress: number | null; error: string | null };

/**
 * Upload files to POST /api/issues/:key/attachments with progress
 * (XMLHttpRequest: fetch has no upload progress events).
 */
export function useAttachmentUpload(issueKey: string, onDone: () => void, connectionId?: number | null) {
  const [state, setState] = useState<UploadState>({
    progress: null,
    error: null,
  });

  const upload = (files: File[]): Promise<boolean> =>
    new Promise(resolve => {
      const total = files.reduce((a, f) => a + f.size, 0);
      if (files.length === 0) return resolve(false);
      if (total > UPLOAD_MAX_BYTES) {
        setState({
          progress: null,
          error: t("ui.upload.tooBig"),
        });
        return resolve(false);
      }
      const form = new FormData();
      for (const f of files) form.append("file", f, f.name);
      const xhr = new XMLHttpRequest();
      xhr.open(
        "POST",
        `/api/issues/${encodeURIComponent(issueKey)}/attachments${connectionId ? `?c=${connectionId}` : ""}`
      );
      xhr.withCredentials = true;
      xhr.upload.onprogress = e => {
        if (e.lengthComputable)
          setState({
            progress: Math.round((e.loaded / e.total) * 100),
            error: null,
          });
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setState({ progress: null, error: null });
          onDone();
          resolve(true);
        } else {
          let message = t("ui.upload.failed", { status: xhr.status });
          try {
            message =
              (JSON.parse(xhr.responseText) as { error?: string }).error ??
              message;
          } catch {
            /* keep generic message */
          }
          setState({ progress: null, error: message });
          resolve(false);
        }
      };
      xhr.onerror = () => {
        setState({ progress: null, error: t("ui.upload.offline") });
        resolve(false);
      };
      setState({ progress: 0, error: null });
      xhr.send(form);
    });

  return {
    ...state,
    upload,
    clearError: () => setState(s => ({ ...s, error: null })),
  };
}
