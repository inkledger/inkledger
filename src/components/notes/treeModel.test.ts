import { describe, expect, it } from "vitest";
import type { NoteTreeItem } from "@contracts/notes";
import {
  ancestorIds,
  buildNoteTree,
  descendantsOf,
  siblingIndices,
} from "./treeModel";

const item = (
  id: string,
  parentId: string | null,
  position = 0
): NoteTreeItem => ({
  id,
  parentId,
  position,
  title: id,
  contentRevision: 1,
  connectionId: null,
  issueKey: null,
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
});
