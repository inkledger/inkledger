import { t } from "@/i18n";
import { storedKey } from "./office";

/** An answer refused by inkledger (401: the key is not valid any more), or no answer at all (0). */
export class PaneError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The add-in's own routes (api/mail/addin.ts), with the add-in key: the session cookie never reaches Outlook. */
export async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/outlook/${path}`, {
      method,
      cache: "no-store",
      headers: { Authorization: `Bearer ${storedKey()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new PaneError(t("ui.outlook.offline"), 0);
  }
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new PaneError(json.error ?? `HTTP ${res.status}`, res.status);
  return json.data as T;
}
