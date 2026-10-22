// React work counted in the browser, on the production bundle as it ships: React calls
// a DevTools hook on every commit (production builds too), so the page script installs
// one before the app loads. Nothing of this is in the app. Validated by renders.test.mjs
// on a fixture whose work is known before any app number is read (docs/dev/measuring.md).

/**
 * Init script (page.addInitScript): counts commits and the components that rendered in
 * each, by the region and the element they draw. A component rendered in a commit when it
 * is new or did work (React's PerformedWork flag); a subtree React left as it was (its
 * children the same fibers as before) is not walked.
 */
export function renderHook() {
  const R = (window.__renders = { commits: 0, renders: 0, where: {} });
  const COMPONENT = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
  const HOST = 5;
  const PERFORMED_WORK = 1;
  const where = fiber => {
    let n = fiber.child;
    while (n && n.tag !== HOST) n = n.child;
    const el = n?.stateNode;
    if (!(el instanceof Element)) return "-";
    const region = el.closest("aside,header,nav,main,[role=dialog],[role=alertdialog]");
    const r = region ? region.getAttribute("role") || region.tagName.toLowerCase() : "body";
    const id = el.getAttribute("data-testid") || el.getAttribute("aria-label") || (el.getAttribute("class") || el.tagName.toLowerCase()).split(" ")[0];
    return `${r} ${id}`.slice(0, 60);
  };
  const walk = first => {
    for (let f = first; f; f = f.sibling) {
      const prev = f.alternate;
      if (COMPONENT.has(f.tag) && (prev === null || (f.flags & PERFORMED_WORK) !== 0)) {
        R.renders++;
        const k = where(f);
        R.where[k] = (R.where[k] || 0) + 1;
      }
      if (prev !== null && f.child === prev.child) continue;
      walk(f.child);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot(_id, root) {
      R.commits++;
      walk(root.current.child);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
}

/** Commits and component renders over `ms`, counted from zero after the page has settled. */
export async function rendersDuring(page, ms) {
  await page.evaluate(() => Object.assign(window.__renders, { commits: 0, renders: 0, where: {} }));
  await page.waitForTimeout(ms);
  const r = await page.evaluate(() => window.__renders);
  return { commits: r.commits, renders: r.renders, top: Object.entries(r.where).sort((a, b) => b[1] - a[1]).slice(0, 8) };
}
