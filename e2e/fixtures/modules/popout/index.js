// A framed (host API v2) module for the e2e tests that only listens over the
// whole window ("page.overlay") to what the page tells it ("page.events"):
// it shows the last event and where its Store card was, when switched on there.
export default {
  id: "popout",
  hostApi: 2,
  mount: {
    "page-overlay"(el, host) {
      const said = document.createElement("p");
      said.dataset.testid = "popout-heard";
      el.append(said);
      const off = host.pageEvents?.(e => {
        if (e.kind === "enabled") said.textContent = `enabled ${JSON.stringify(e.from)}`;
      });
      return () => {
        off?.();
        said.remove();
      };
    },
  },
};
