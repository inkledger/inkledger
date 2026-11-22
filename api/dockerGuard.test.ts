// scripts/docker-update.mjs refuses an env file that points the new stack at the old jtt one.
import { describe, expect, it } from "vitest";

import { jttDatabaseUrl } from "../scripts/docker-guard.mjs";

describe("docker-update's jtt guard", () => {
  it("refuses the jtt database or host in every spelling", () => {
    for (const line of [
      "DATABASE_URL=postgres://u:p@jtt-db:5432/inkledger",
      "DATABASE_URL=postgres://u:p@db:5432/jtt",
      "export DATABASE_URL=postgres://u:p@jtt-db:5432/inkledger",
      "DATABASE_URL=postgres://u:p@jtt-db",
      "DATABASE_URL='postgres://u:p@host.docker.internal:54329/inkledger'",
    ]) {
      expect(jttDatabaseUrl(`# staging\n${line}\n`), line).not.toBeNull();
    }
  });

  it("lets the staging stack's own database through", () => {
    expect(jttDatabaseUrl("DATABASE_URL=postgres://inkledger:p@db:5432/inkledger\nPOSTGRES_PASSWORD=p\n")).toBeNull();
    expect(jttDatabaseUrl("# DATABASE_URL=postgres://u:p@jtt-db/jtt\n")).toBeNull();
  });
});
