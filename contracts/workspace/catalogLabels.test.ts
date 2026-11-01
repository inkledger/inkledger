import { describe, expect, it } from "vitest";
import { lookup, type Tree } from "../i18n/core";
import { en } from "../i18n/en";
import { it as italian } from "../i18n/it";
import { CATALOG_V1 } from "./catalogV1";

/** Every name the Studio, FlowMap and the planner show for a block or a control: a missing one would show its key. */
const keys = [...new Set([
  ...CATALOG_V1.anchors.flatMap(anchor => [anchor.accessibility.labelKey, anchor.studio.descriptionKey]),
  ...CATALOG_V1.controls.map(control => control.accessibility.labelKey),
])].sort();

describe("workspace catalog labels", () => {
  for (const [locale, tree] of [["en", en], ["it", italian]] as const) {
    it(`resolves every block and control name in ${locale}`, () => {
      expect(keys.filter(key => lookup(tree as unknown as Tree, key) === undefined)).toEqual([]);
    });
  }
});
