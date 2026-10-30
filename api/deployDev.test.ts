// The development services' compose file (docs/work/ideas/infra.md R-5.1, AC-5.1): read
// as Docker reads it (`docker compose config`), so no YAML parser of our own. Skipped,
// and said so, where docker isn't installed.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const hasDocker = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The file as Docker reads it; a broken or missing file throws (and fails the test). */
const composeConfig = (profiles: string[] = []): unknown =>
  JSON.parse(execFileSync("docker", ["compose", "-f", "deploy/dev.yml", ...profiles, "config", "--format", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

describe("deploy/dev.yml", () => {
  it.skipIf(!hasDocker)("the dev stack declares db, ai and ml", () => {
    const c = composeConfig() as { name: string; services: Record<string, { container_name?: string; image?: string; ports?: { host_ip?: string; published?: string; target?: number }[]; tmpfs?: string[]; volumes?: unknown[] }> };
    expect(c.name).toBe("inkledger-dev");
    const db = c.services["test-db"];
    expect(db.container_name).toBe("inkledger-test-db");
    // Pinned, never a moving tag alone.
    expect(db.image).toMatch(/^postgres:17-alpine@sha256:[0-9a-f]{64}$/);
    // Only this machine, on its own port: never 54329 (jtt) or 54330 (staging).
    expect(db.ports).toEqual([expect.objectContaining({ host_ip: "127.0.0.1", published: "54331", target: 5432 })]);
    expect(db.tmpfs).toEqual(["/var/lib/postgresql/data"]);
    expect(db.volumes ?? []).toEqual([]);
    // Ollama only on request (profile ai), pinned, local, bounded (infra Q3: 8 GB, 4 CPU).
    expect(c.services.ollama).toBeUndefined();
    const ai = composeConfig(["--profile", "ai"]) as { services: Record<string, { image?: string; ports?: { host_ip?: string; published?: string }[]; mem_limit?: string | number; cpus?: number; environment?: Record<string, string> }> };
    const ollama = ai.services.ollama;
    expect(ollama.image).toMatch(/^ollama\/ollama:[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(ollama.ports).toEqual([expect.objectContaining({ host_ip: "127.0.0.1", published: "11434" })]);
    expect(Number(ollama.mem_limit)).toBe(8 * 1024 ** 3);
    expect(Number(ollama.cpus)).toBe(4);
    expect(ollama.environment?.OLLAMA_KEEP_ALIVE).toBe("5m");
    // Nothing of the other stacks.
    expect(JSON.stringify(c)).not.toMatch(/jtt|inkledger-db\b|54329|54330/);
  });
});
