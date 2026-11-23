import { failureOf } from "@contracts/sync";
import { t } from "@/i18n";

/** A recorded sync failure in the user's words: from its kind and status, never the service's English. */
export function syncFailureText(lastError: string): string {
  const f = failureOf(lastError);
  if (!f) return t("ui.syncFailure.other");
  if (f.signInDenied) return t("ui.syncFailure.signInDenied");
  if (f.kind === "unavailable") return t(f.status === undefined ? "ui.syncFailure.unavailable" : "ui.syncFailure.serverError");
  return t(`ui.syncFailure.${f.kind}`);
}
