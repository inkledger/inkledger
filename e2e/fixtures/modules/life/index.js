// Framed demo modules (host API v2) for the frame budget, the panel's edge,
// the phone's dock and a removed view's cleanup: a runtime and two views
// each, as the ported modules have. The test installs copies under other ids
// (the id below is replaced).
export default {
  id: "life",
  hostApi: 2,
  runtime(host) {
    return host.views(() => {});
  },
  mount: {
    "dashboard-widget"(el, host) {
      const p = document.createElement("p");
      p.dataset.testid = "life";
      p.textContent = `life ${host.moduleId}`;
      el.append(p);
      // Its cleanup says it ran (the page hears a frame's console).
      return () => {
        console.info(`life cleanup ran: ${host.moduleId}`);
        p.remove();
      };
    },
    "panel-edge"(el, host) {
      // A burrow on the edge: 40 px square, its foot 10 px over the strip's bottom (the panel's edge).
      const dot = document.createElement("div");
      dot.dataset.testid = "life-edge";
      Object.assign(dot.style, { position: "absolute", left: "0", bottom: "10px", width: "40px", height: "40px" });
      el.append(dot);
      host.hit.set([{ kind: "rect", x: 0, y: 34, w: 40, h: 40 }], () => (dot.textContent = "edge hit"), { label: "Life" });
      return () => dot.remove();
    },
    "mobile-dock"(el, host) {
      const pill = document.createElement("button");
      pill.dataset.testid = "life-pill";
      Object.assign(pill.style, { position: "absolute", right: "0", bottom: "8px", height: "44px", width: "120px" });
      pill.textContent = "playing";
      pill.addEventListener("click", () => {
        pill.textContent = "stopped";
        host.dock?.set(false);
      });
      el.append(pill);
      host.dock?.set(true);
      return () => pill.remove();
    },
  },
};
