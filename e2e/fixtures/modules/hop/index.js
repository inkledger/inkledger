// A framed (host API v2) module over the whole window ("page.overlay") for the
// e2e tests: the test puts its shape where it wants (window.place, in the
// window's px), and reads the clicks and drags it got (window.heard).
export default {
  id: "hop",
  hostApi: 2,
  mount: {
    "page-overlay"(el, host) {
      window.heard = [];
      window.place = (x, y, w, h) =>
        host.hit.set([{ kind: "rect", x, y, w, h }], how => window.heard.push(how?.via ?? "click"), {
          label: "Hop",
          onDrag: d => window.heard.push(`drag:${d.phase}`),
        });
      return () => host.hit.set([], () => {});
    },
  },
};
