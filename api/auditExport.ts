// GET /api/audit/export?format=csv|json&…filters: the audit log as a file, streamed page by
// page (never held whole in memory). For whoever may export it (exportAudit); the export is
// itself an event.
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { restUser } from "./context";
import { auditPages, record, type AuditFilters } from "./lib/audit";
import { auditFilterInput } from "./routers/audit";
import { dayKey } from "@contracts/time";
import type { AuditEventView } from "@contracts/audit";

const COLUMNS = ["id", "at", "actorKind", "actorUserId", "actorLabel", "action", "outcome", "targetType", "targetId", "targetOwnerUserId", "ip", "before", "after"] as const;

/** A CSV field: quoted when it must be, and never read as a formula by a spreadsheet. */
export function csvField(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const csvRow = (e: AuditEventView) => COLUMNS.map((c) => csvField(c === "at" ? new Date(e.at).toISOString() : e[c])).join(",") + "\r\n";

function filtersOf(url: URL): AuditFilters | null {
  const raw = Object.fromEntries(url.searchParams);
  const num = (k: string) => (raw[k] !== undefined && raw[k] !== "" ? Number(raw[k]) : undefined);
  const parsed = auditFilterInput.safeParse({
    actorUserId: num("actorUserId"),
    action: raw.action || undefined,
    targetType: raw.targetType || undefined,
    targetId: raw.targetId || undefined,
    outcome: raw.outcome || undefined,
    from: num("from"),
    to: num("to"),
  });
  return parsed.success ? parsed.data : null;
}

export function registerAuditRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  app.get("/api/audit/export", async (c) => {
    const who = await restUser(c.req.raw, "exportAudit");
    if ("status" in who) return c.json({ error: who.error }, who.status);
    const url = new URL(c.req.url);
    const format = url.searchParams.get("format") === "json" ? "json" : "csv";
    const filters = filtersOf(url);
    if (!filters) return c.json({ error: "Bad Request" }, 400);
    const encoder = new TextEncoder();
    let rows = 0;
    const pages = auditPages(filters);
    // Recorded as it starts: a download cancelled halfway was still an export.
    await record({ req: c.req.raw, remoteAddress: c.env?.incoming?.socket?.remoteAddress, user: who.user }, "audit.export", { target: { type: "audit" }, after: { format, filters } });
    // Pulled page by page: a slow download holds the next query back.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(format === "csv" ? COLUMNS.join(",") + "\r\n" : "["));
      },
      async pull(controller) {
        try {
          const next = await pages.next();
          if (next.done) {
            if (format === "json") controller.enqueue(encoder.encode("]"));
            controller.close();
            return;
          }
          const page = next.value;
          controller.enqueue(encoder.encode(format === "csv" ? page.map(csvRow).join("") : page.map((e, i) => (rows + i > 0 ? "," : "") + JSON.stringify(e)).join("")));
          rows += page.length;
        } catch (e) {
          controller.error(e);
        }
      },
      async cancel() {
        await pages.return(undefined);
      },
    });
    const name = `inkledger-audit-${dayKey(new Date())}.${format}`;
    return new Response(stream, {
      headers: {
        "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      },
    });
  });
}
