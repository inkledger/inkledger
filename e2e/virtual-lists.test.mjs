// Searchable lists over a real-sized catalogue (2000 issues): Quick start, ⌘K and the issue
// pickers draw only the rows in view (src/components/app/VirtualCommand.tsx), keep cmdk's keys
// and say each option's place in the whole list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, withApp } from "./harness.mjs";

const ISSUES = 2000;
const seed = async db => {
  await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
  await db.q(
    `INSERT INTO issues (user_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at, favorite)
     SELECT 1, 'PERF-' || g, 'PERF-' || g, 'Performance task number ' || g || ' with a longer summary like real ones',
            'To Do', 'To Do', 'PERF', 'Performance', 'Task', 'Medium', '[]', 'mrossi', 'https://jira.example.it/browse/PERF-' || g, ?, CASE WHEN g % 50 = 0 THEN 1 ELSE 0 END
       FROM generate_series(1, ${ISSUES}) g`,
    Date.now(),
  );
};

/**
 * Serious and critical violations. Left out: the size of the dialogs' shared close button
 * (14 px, under WCAG 2.2's 24 px): every dialog has it, the lists here don't change it.
 */
async function axeViolations(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () =>
    (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations
      .filter(v => v.impact === "serious" || v.impact === "critical")
      .map(v => ({ ...v, nodes: v.id === "target-size" ? v.nodes.filter(n => !n.html.includes('data-slot="dialog-close"')) : v.nodes }))
      .filter(v => v.nodes.length > 0)
      .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`),
  );
}

/** The active option as the input names it: its text, place and set size (once its scroll has settled). */
const activeOf = async dialog => {
  await dialog.page().waitForTimeout(150);
  return activeNow(dialog);
};
const activeNow = dialog =>
  dialog.evaluate(root => {
    const input = root.querySelector('[role="combobox"][aria-controls]');
    const option = document.getElementById(input?.getAttribute("aria-activedescendant") ?? "");
    const list = root.querySelector('[role="listbox"]');
    const box = option?.getBoundingClientRect();
    const view = list?.getBoundingClientRect();
    return option
      ? {
          text: option.textContent ?? "",
          pos: Number(option.getAttribute("aria-posinset")),
          size: Number(option.getAttribute("aria-setsize")),
          selected: option.getAttribute("aria-selected"),
          inView: !!box && !!view && box.top >= view.top - 1 && box.bottom <= view.bottom + 1,
        }
      : null;
  });

test("Quick start over 2000 issues: only the rows in view, every key, Enter starts the one reached", () =>
  withApp({ viewport: { width: 1400, height: 900 }, seed }, async ({ page, base, db }) => {
    // No opening fade: colours are measured as they stay.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(base + "/");
    await page.locator('[data-workspace-control="shell.quickStart.open"]').first().click();
    const dialog = page.getByRole("dialog", { name: "Start timer" });
    const input = dialog.getByPlaceholder("Start timer on… (key or title)");
    await input.waitFor();
    await dialog.getByRole("option").first().waitFor();
    const drawn = await dialog.getByRole("option").count();
    assert.ok(drawn < 60, `only the rows in view are drawn (${drawn})`);
    const first = await activeOf(dialog);
    assert.equal(first?.pos, 1);
    assert.ok(first && first.size >= ISSUES, `the set size is the whole list (${first?.size})`);
    assert.equal(first?.selected, "true");

    // Keys: End, Home, PageDown, Alt+↓ (next section), Ctrl+N.
    await input.press("End");
    assert.equal((await activeOf(dialog))?.pos, first.size);
    assert.equal((await activeOf(dialog))?.inView, true);
    await input.press("Home");
    assert.equal((await activeOf(dialog))?.pos, 1);
    await input.press("PageDown");
    assert.ok(((await activeOf(dialog))?.pos ?? 0) > 2);
    await input.press("Home");
    await input.press("Alt+ArrowDown");
    const nextSection = await activeOf(dialog);
    assert.ok((nextSection?.pos ?? 0) > 1, "Alt+↓ goes to the next section");
    await input.press("Control+n");
    assert.equal((await activeOf(dialog))?.pos, (nextSection?.pos ?? 0) + 1);

    // A search, then 30 steps down: the active option stays drawn, in view and named by the input.
    await input.fill("task number 15");
    await page.waitForFunction(() => {
      const o = document.querySelector('[role="dialog"] [role="option"][aria-selected="true"]');
      return !!o && Number(o.getAttribute("aria-setsize")) < 400;
    });
    for (let i = 0; i < 30; i++) await input.press("ArrowDown");
    const reached = await activeOf(dialog);
    assert.equal(reached?.pos, 31);
    assert.equal(reached?.inView, true);
    const key = /PERF-\d+/.exec(reached?.text ?? "")?.[0];
    assert.ok(key, `an issue is active (${reached?.text})`);
    assert.deepEqual(await axeViolations(page), [], "Quick start open");
    await input.press("Enter");
    // An open hole of the day asks first: from now.
    const ask = page.getByRole("alertdialog", { name: `Start ${key}` });
    if (await ask.isVisible({ timeout: 1500 }).catch(() => false)) await ask.getByRole("button", { name: "From now" }).click();
    for (let i = 0; i < 50 && !(await db.q("SELECT 1 FROM timers WHERE issue_key = ?", key)).length; i++) await page.waitForTimeout(100);
    assert.equal((await db.q("SELECT issue_key FROM timers WHERE state = 'running'"))[0]?.issue_key, key);
  }));

test("⌘K over 2000 issues: only the rows in view, an issue at the end of the list opens", () =>
  withApp({ viewport: { width: 1400, height: 900 }, seed }, async ({ page, base }) => {
    await page.goto(base + "/");
    await page.locator("[data-surface-stage]").first().waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Search" });
    const input = palette.getByRole("combobox");
    await input.waitFor();
    assert.ok((await palette.getByRole("option").count()) < 60, "only the rows in view are drawn");
    await input.fill("PERF-1999");
    await palette.getByRole("option", { name: /PERF-1999/ }).first().waitFor();
    await input.press("Enter");
    await page.waitForURL(url => /PERF-1999/.test(url.toString()));
  }));

test("a TODO's issue picker over 2000 issues: search, Enter; at 320 px nothing goes sideways", () =>
  withApp({ viewport: { width: 320, height: 760 }, seed }, async ({ page, base }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(base + "/todos");
    await page.getByRole("button", { name: "Tie to an issue…" }).first().click();
    const search = page.getByPlaceholder("Search an issue by key or title…");
    await search.fill("PERF-1500");
    await page.getByRole("option", { name: /PERF-1500/, selected: true }).waitFor();
    assert.ok((await page.getByRole("option").count()) < 60);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no sideways scroll (${overflow})`);
    assert.deepEqual(await axeViolations(page), [], "the picker open");
    await search.press("Enter");
    await page.getByRole("button", { name: /Tied to PERF-1500/ }).waitFor();
  }));
