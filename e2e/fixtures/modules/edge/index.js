// Draws a 160×60 box above the panel's bottom-left corner that lets clicks
// through, like a pet peeking out of its burrow.
export default {
  id: "edge",
  hostApi: 1,
  mount: {
    "panel-edge"(el) {
      const box = document.createElement("div");
      box.dataset.testid = "module-edge";
      Object.assign(box.style, { position: "absolute", left: "0", bottom: "0", width: "160px", height: "60px", pointerEvents: "none", background: "rgb(0 0 0 / 0.05)" });
      el.append(box);
      return () => box.remove();
    },
  },
};
