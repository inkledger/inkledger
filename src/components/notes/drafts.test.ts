import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteDraft,
  draftPath,
  findDraft,
  listDrafts,
  newDraftId,
  writeDraft,
  type NoteDraft,
} from "./drafts";

function storageMock() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

const draft = (overrides: Partial<NoteDraft> = {}): NoteDraft => ({
  version: 1,
  userId: 7,
  noteId: null,
  draftId: "draft-one",
  tabId: "tab-one",
  baseContentRevision: 0,
  title: "Recover me",
  body: "**text**",
  parentId: null,
  issue: null,
  updatedAt: 100,
  ...overrides,
});

describe("local note drafts", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", storageMock());
    vi.stubGlobal("sessionStorage", storageMock());
  });

  it("round-trips and finds drafts across tabs", () => {
    expect(writeDraft(draft())).toBe(true);
    expect(findDraft(7, null, "draft-one")?.title).toBe("Recover me");
    expect(listDrafts(7)).toHaveLength(1);
    expect(listDrafts(8)).toHaveLength(0);
  });

  it("deletes only the addressed draft and preserves issue/parent metadata in its path", () => {
    const value = draft({
      noteId: "note-one",
      parentId: "parent-one",
      issue: { issueKey: "APP-1", connectionId: 3 },
    });
    writeDraft(value);
    writeDraft(draft());
    expect(draftPath(value)).toBe("/notes/note-one?draft=draft-one");
    expect(
      draftPath(draft({ issue: { issueKey: "APP-1", connectionId: 3 } }))
    ).toContain("issueKey=APP-1");
    deleteDraft(value);
    expect(findDraft(7, "note-one", "draft-one")).toBeNull();
    expect(listDrafts(7)).toHaveLength(1);
  });

  it("ignores malformed or oversized stored values", () => {
    localStorage.setItem(
      "ikl-note-draft:v1:7:new:bad:tab-one",
      JSON.stringify(draft({ body: "x".repeat(65_001) }))
    );
    localStorage.setItem("ikl-note-draft:v1:7:new:broken:tab-one", "not json");
    expect(listDrafts(7)).toEqual([]);
    expect(newDraftId()).not.toBe(newDraftId());
  });
});
