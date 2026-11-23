// A framed (host API v2) module for the e2e tests that maps "page.importance"
// over the whole window ("page.overlay"), again and again: each finished map
// is shown with its round, a digit per point (0 free, 8 data, 1 important).
const STEP = 10;
export default {
  id: "ink",
  hostApi: 2,
  mount: {
    "page-overlay"(el, host) {
      const out = document.createElement("pre");
      out.dataset.testid = "ink-map";
      el.append(out);
      let live = true;
      (async () => {
        for (let round = 1; live; round++) {
          const { width, height } = el.getBoundingClientRect();
          const cols = Math.floor(width / STEP);
          const rows = Math.floor(height / STEP);
          const points = [];
          for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) points.push([c * STEP + STEP / 2, r * STEP + STEP / 2]);
          const values = [];
          for (let i = 0; i < points.length && live; ) {
            try {
              values.push(...(await host.page.importance(points.slice(i, i + 600))));
              i += 600;
            } catch {
              // Four calls a second: wait for the next one.
              await new Promise(r => setTimeout(r, 300));
            }
          }
          if (live) out.textContent = JSON.stringify({ round, step: STEP, cols, rows, v: values.map(v => (v === 1 ? 1 : v > 0 ? 8 : 0)).join("") });
        }
      })();
      return () => {
        live = false;
        out.remove();
      };
    },
  },
};
