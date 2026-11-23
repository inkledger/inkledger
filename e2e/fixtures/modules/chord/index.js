// A framed (host API v2) module for the e2e tests with a keyboard command
// ("commands" in its manifest): over the whole window ("page.overlay") it
// shows each command it hears ("page.events") and how many so far.
export default {
  id: "chord",
  hostApi: 2,
  mount: {
    "page-overlay"(el, host) {
      const said = document.createElement("p");
      said.dataset.testid = "chord-heard";
      el.append(said);
      let n = 0;
      const off = host.pageEvents?.(e => {
        if (e.kind === "command") said.textContent = `command ${e.id} ${++n}`;
      });
      return () => {
        off?.();
        said.remove();
      };
    },
  },
};
