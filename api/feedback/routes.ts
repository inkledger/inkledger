// A feedback's screenshot (contracts/feedback.ts): sent by its author right after the
// feedback itself (JSON calls stay small), kept sealed, shown to whoever may read the
// feedback. The type is read from the bytes, never taken from the browser.
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { and, eq, isNull } from "drizzle-orm";
import { feedback } from "@db/schema";
import { FEEDBACK_SCREENSHOT_MAX_BYTES, FEEDBACK_SCREENSHOT_TYPES } from "@contracts/feedback";
import { t } from "@contracts/i18n";
import { restUser } from "../context";
import { holds } from "../queries/accounts";
import { getDb } from "../queries/connection";
import { openBytesFor, sealBytesFor } from "../lib/crypto";
import { sniffImage } from "../ideaFiles";
import { attachmentHeaders } from "../attachments";
import { forwardQueued, screenshotScope } from "./upstream";
import { feedbackRow } from "./store";

type App = Hono<{ Bindings: HttpBindings }>;

const idOf = (raw: string) => {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export function registerFeedbackRoutes(app: App) {
  /** The screenshot of one's own new feedback (multipart "file"), once. */
  app.post("/api/feedback/:id/screenshot", async (c) => {
    const id = idOf(c.req.param("id"));
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const row = id ? await feedbackRow(id) : undefined;
    if (!row || row.userId !== who.user.id) return c.json({ error: t("server.feedback.notFound") }, 404);
    if (row.screenshot) return c.json({ error: t("server.feedback.screenshotTaken") }, 409);
    let file: File | null;
    try {
      const got = (await c.req.formData()).get("file");
      file = got instanceof File && got.size > 0 ? got : null;
    } catch {
      return c.json({ error: t("server.attachments.invalidRequest") }, 400);
    }
    if (!file) return c.json({ error: t("server.attachments.noFile") }, 400);
    if (file.size > FEEDBACK_SCREENSHOT_MAX_BYTES) return c.json({ error: t("server.feedback.screenshotTooLarge", { mb: 1 }) }, 413);
    const bytes = Buffer.from(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type || !(FEEDBACK_SCREENSHOT_TYPES as readonly string[]).includes(type)) return c.json({ error: t("server.feedback.screenshotNotImage") }, 415);
    const [saved] = await getDb()
      .update(feedback)
      .set({ screenshot: sealBytesFor(bytes, screenshotScope(row.uid)), screenshotType: type })
      .where(and(eq(feedback.id, row.id), isNull(feedback.screenshot)))
      .returning({ id: feedback.id, shareState: feedback.shareState });
    if (!saved) return c.json({ error: t("server.feedback.screenshotTaken") }, 409);
    // The feedback waited for its picture to be sent with it.
    if (saved.shareState === "queued") void forwardQueued({ ids: [saved.id] }).catch(() => undefined);
    return c.json({ ok: true });
  });

  /** The screenshot, for whoever may read the feedback (its author, readFeedback). */
  app.get("/api/feedback/:id/screenshot", async (c) => {
    const id = idOf(c.req.param("id"));
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const row = id ? await feedbackRow(id) : undefined;
    if (!row || (row.userId !== who.user.id && !holds(who.user, "readFeedback")) || !row.screenshot || !row.screenshotType) return c.json({ error: t("server.feedback.notFound") }, 404);
    const bytes = openBytesFor(row.screenshot, screenshotScope(row.uid));
    return new Response(new Uint8Array(bytes), { headers: attachmentHeaders(row.screenshotType, `feedback-${row.id}`) });
  });
}
