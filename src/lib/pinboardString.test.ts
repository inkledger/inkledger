import { describe, expect, it } from "vitest";
import { NOTE_SIZE, freeSlotNear } from "@contracts/pinboard";
import { pinOf, stringPath, threads } from "@/lib/pinboardString";

describe("pinboard strings", () => {
  it("ties each hung note to its own issue's post-it, pin to pin", () => {
    const notes = [
      { id: 1, issueKey: "APP-1", issueNoteId: null, x: 100, y: 100 },
      { id: 2, issueKey: "APP-1", issueNoteId: 9, x: 400, y: 150 },
      { id: 3, issueKey: "APP-2", issueNoteId: 10, x: 700, y: 150 }, // its issue is not on this board
      { id: 4, issueKey: null, issueNoteId: null, x: 50, y: 600 },
    ];
    const ts = threads(notes);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ id: 2, from: pinOf({ x: 400, y: 150 }), to: pinOf({ x: 100, y: 100 }) });
    expect(pinOf({ x: 0, y: 0 })).toEqual({ x: NOTE_SIZE / 2, y: 12 });
  });

  it("follows a post-it while it is dragged", () => {
    const notes = [
      { id: 1, issueKey: "APP-1", issueNoteId: null, x: 100, y: 100 },
      { id: 2, issueKey: "APP-1", issueNoteId: 9, x: 400, y: 150 },
    ];
    const [t] = threads(notes, new Map([[1, { x: 900, y: 800 }]]));
    expect(t.to).toEqual(pinOf({ x: 900, y: 800 }));
  });

  it("sags below the straight line, more when longer, never upwards", () => {
    const ctrlY = (d: string) => Number(d.split(" ")[5]);
    const short = stringPath({ x: 0, y: 100 }, { x: 100, y: 100 });
    const long = stringPath({ x: 0, y: 100 }, { x: 900, y: 100 });
    expect(ctrlY(short)).toBeGreaterThan(100);
    expect(ctrlY(long)).toBeGreaterThan(ctrlY(short));
    expect(stringPath({ x: 0, y: 0 }, { x: 10, y: 0 })).toMatch(/^M 0 0 Q 5 \d+(\.\d)? 10 0$/);
  });

  it("hangs a note beside its issue, not on it nor on other notes", () => {
    const anchor = { x: 200, y: 200 };
    const p = freeSlotNear(anchor, []);
    expect(Math.abs(p.x - anchor.x) >= NOTE_SIZE * 0.75 || Math.abs(p.y - anchor.y) >= NOTE_SIZE * 0.75).toBe(true);
    const q = freeSlotNear(anchor, [p]);
    expect(q).not.toEqual(p);
  });
});
