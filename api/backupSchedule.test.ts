// The backup schedule never stops by itself: a failed read of its settings
// tries again later, and two reschedules in a row arm a single backup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

const settings = vi.hoisted(() => ({ fail: 0, reads: 0 }));
vi.mock("./lib/serverSettings", () => ({
  getServerSetting: async <T>(_key: string, fallback: T): Promise<T> => {
    settings.reads++;
    if (settings.fail > 0) {
      settings.fail--;
      throw new Error("database away");
    }
    return fallback;
  },
  setServerSetting: async () => undefined,
}));

describe("the backup schedule", () => {
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 9, 21, 10, 0) });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    settings.fail = 0;
    settings.reads = 0;
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a settings read that fails is tried again later, and the next one arms the backup", async () => {
    const { startBackupScheduler, RESCHEDULE_RETRY_MS } = await import("./backup");
    settings.fail = 1;
    stop = startBackupScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.reads).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/schedule not read, trying again/));

    await vi.advanceTimersByTimeAsync(RESCHEDULE_RETRY_MS);
    expect(settings.reads).toBe(2);
    // Daily at 02:00: the next one is armed.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("two reschedules in a row arm one backup, not two", async () => {
    const { startBackupScheduler, reschedule } = await import("./backup");
    stop = startBackupScheduler();
    reschedule();
    reschedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.reads).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stopped, nothing is armed again (not even by a read still on its way)", async () => {
    const { startBackupScheduler } = await import("./backup");
    stop = startBackupScheduler();
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
