// React work counted in the browser, on the production bundle as it ships: React calls
// a DevTools hook on every commit (production builds too), so the page script installs
// one before the app loads. Nothing of this is in the app. Validated by renders.test.mjs
// on a fixture whose work is known before any app number is read (docs/dev/measuring.md).
// It reads React's internals (fiber tags, the PerformedWork flag, alternate/child links),
// checked with React 19.2: after an upgrade, that validation says whether they still hold.

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

/**
 * Init script: counts the event stream's errors (a drop, a failed reconnect) and opens, in
 * window.__stream. The app's live state follows them: down, it polls at its fallback rate and
 * refetches everything when back.
 */
export function streamProbe() {
  const S = (window.__stream = { errors: 0, opens: 0 });
  const Native = window.EventSource;
  if (!Native) return;
  window.EventSource = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener("error", () => S.errors++);
      this.addEventListener("open", () => S.opens++);
    }
  };
}

/**
 * Steps a page under Playwright's clock (page.clock.install before it loads) one second at a
 * time, each step waiting for the requests it started and React's commits: the page's time
 * runs on the stepped clock, its network and rendering in real time.
 */
export function clockStepper(page) {
  // The event stream stays open by design: only requests that end are waited for.
  const counted = r => r.resourceType() !== "eventsource";
  let inflight = 0;
  page.on("request", r => counted(r) && inflight++);
  const done = r => counted(r) && inflight--;
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  // Up to 30 s for a step's requests: a slow answer (a loaded machine) must not overlap the
  // next steps' timers, or polls and refetches pile up that real time would never see.
  const settle = async () => {
    for (let i = 0; i < 1500 && inflight > 0; i++) await page.waitForTimeout(20);
    await page.waitForTimeout(60);
  };
  return {
    settle,
    async run(ms, step = 1000) {
      for (let t = 0; t < ms; t += step) {
        await page.clock.runFor(step);
        await settle();
      }
    },
  };
}

/** Commits and component renders while `run()` goes, counted from zero. */
export async function rendersOver(page, run) {
  await page.evaluate(() => Object.assign(window.__renders, { commits: 0, renders: 0, where: {} }));
  await run();
  const r = await page.evaluate(() => window.__renders);
  return { commits: r.commits, renders: r.renders, top: Object.entries(r.where).sort((a, b) => b[1] - a[1]).slice(0, 8) };
}
