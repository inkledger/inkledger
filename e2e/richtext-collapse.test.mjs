// A long description shown collapsed: links cut off below "Show all" can't be
// tabbed to (focus would land on something invisible); shown, they can.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, fakeProcedures } from "./harness.mjs";

const para = text => ({ t: "p", c: [{ t: "text", v: text }] });
const LONG = {
  v: 1,
  blocks: [
    { t: "p", c: [{ t: "link", url: "https://example.com/top", c: [{ t: "text", v: "Top link" }] }] },
    ...Array.from({ length: 30 }, (_, i) => para(`Line ${i} of a long description that goes on and on.`)),
    { t: "p", c: [{ t: "link", url: "https://example.com/bottom", c: [{ t: "text", v: "Bottom link" }] }] },
  ],
};

test("a collapsed description: the cut-off link is out of the tab order until Show all", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    await fakeProcedures(page, { "issues.description": { doc: LONG, text: "A long description" } });
    await page.goto(`${base}/issues/DEMO-101`);
    const showAll = page.getByRole("button", { name: "Show all" });
    await showAll.waitFor();
    // A link to a domain not allowed yet is a button (asks first): either way, what focus lands on.
    const focusable = text => page.getByText(text, { exact: true }).locator("xpath=ancestor-or-self::*[self::a or self::button][1]");
    const top = focusable("Top link");
    const bottom = focusable("Bottom link");
    assert.notEqual(await top.getAttribute("tabindex"), "-1", "the visible link stays reachable");
    assert.equal(await bottom.getAttribute("tabindex"), "-1", "the hidden link is out of the tab order");
    await showAll.click();
    await page.getByRole("button", { name: "Show less" }).waitFor();
    assert.notEqual(await bottom.getAttribute("tabindex"), "-1", "shown: reachable again");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
