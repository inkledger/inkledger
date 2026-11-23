// A framed (host API v2) module for the e2e tests over the whole window
// ("page.overlay"): asks "page.info" and "page.ledges" again and again and
// shows each answer with its round and how long the info call took.
export default {
  id: "ledge",
  hostApi: 2,
  mount: {
    "page-overlay"(el, host) {
      const out = document.createElement("pre");
      out.dataset.testid = "ledge-map";
      el.append(out);
      let live = true;
      (async () => {
        for (let round = 1; live; round++) {
          try {
            const t0 = performance.now();
            const info = await host.info();
            const ms = performance.now() - t0;
            const ledges = await host.ledges();
            if (live) out.textContent = JSON.stringify({ round, ms, ledges, info });
          } catch {
            // Four calls a second: the next round asks again.
          }
          await new Promise(r => setTimeout(r, 300));
        }
      })();
      return () => {
        live = false;
        out.remove();
      };
    },
  },
};
