import { describe, expect, it } from "vitest";
import type { NoteTreeItem } from "@contracts/notes";
import {
  ancestorIds,
  buildNoteTree,
  descendantsOf,
  folderTarget,
  freeName,
  siblingIndices,
} from "./treeModel";

const item = (
  id: string,
  parentId: string | null,
  position = 0,
  kind: NoteTreeItem["kind"] = "note"
): NoteTreeItem => ({
  id,
  parentId,
  kind,
  hasText: false,
  position,
  title: id,
  contentRevision: 1,
  connectionId: null,
  issueKey: null,
  notedOn: null,
  hasAi: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

describe("note tree model", () => {
  const rows = [
    item("a", null),
    item("b", "a"),
    item("c", "b"),
    item("d", null),
    item("e", "a"),
  ];

  it("builds the hierarchy without duplicating children", () => {
    const roots = buildNoteTree(rows);
    expect(roots.map(node => node.id)).toEqual(["a", "d"]);
    expect(roots[0].children.map(node => node.id)).toEqual(["b", "e"]);
    expect(roots[0].children[0].children[0].id).toBe("c");
  });

  it("finds ancestors and the complete descendant exclusion set", () => {
    expect(ancestorIds(rows, "c")).toEqual(["b", "a"]);
    expect([...descendantsOf(rows, "a")].sort()).toEqual(["a", "b", "c", "e"]);
  });

  it("offers insertion positions without counting the moved node", () => {
    expect(siblingIndices(rows, "b", "a")).toEqual([0]);
    expect(siblingIndices(rows, "a", null)).toEqual([0]);
  });

  it("does not loop forever on malformed cyclic data", () => {
    const cyclic = [item("a", "c"), item("b", "a"), item("c", "b")];
    expect(ancestorIds(cyclic, "a")).toEqual(["c", "b"]);
  });

  it("creates in the selected folder, or in the folder holding the selected note", () => {
    const tree = [
      item("work", null, 0, "folder"),
      item("plan", "work"),
      item("sub", "plan"),
      item("loose", null, 1),
    ];
    expect(folderTarget(tree, "work")).toBe("work");
    expect(folderTarget(tree, "sub")).toBe("work");
    expect(folderTarget(tree, "loose")).toBeNull();
    expect(folderTarget(tree, undefined)).toBeNull();
  });

  it("names a new folder with a name not taken beside it", () => {
    const tree = [
      { ...item("a", null, 0, "folder"), title: "New folder" },
      { ...item("b", null, 1, "folder"), title: "new folder 2" },
      { ...item("c", "a", 0, "folder"), title: "Other" },
    ];
    const numbered = (n: number) => `New folder ${n}`;
    expect(freeName(tree, null, "New folder", numbered)).toBe("New folder 3");
    expect(freeName(tree, "a", "New folder", numbered)).toBe("New folder");
  });
});
