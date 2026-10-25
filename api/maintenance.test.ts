import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("the server in maintenance (a restore under way)", () => {
  let app: typeof import("./boot").default;
  beforeAll(async () => {
    app = (await import("./boot")).default;
  });

  it("refuses writes with 503 and says why; reads, health and the backup itself go on", async () => {
    const m = await import("./lib/maintenance");
    m.enterMaintenance("restore");
    try {
      const write = await app.request("http://localhost/api/trpc/worklogs.create", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(write.status).toBe(503);
      expect(((await write.json()) as { error: string }).error).toMatch(/restoring a backup/);
      expect((await app.request("http://localhost/api/health")).status).not.toBe(503);
      const backup = await app.request("http://localhost/api/trpc/backup.restore", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(backup.status).not.toBe(503);
      const sneaked = await app.request("http://localhost/api/trpc/backup.restore,worklogs.create?batch=1", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(sneaked.status).toBe(503);
    } finally {
      m.leaveMaintenance();
    }
    const after = await app.request("http://localhost/api/trpc/worklogs.create", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(after.status).not.toBe(503);
  });
});
