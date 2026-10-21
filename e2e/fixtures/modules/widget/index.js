// Fills its dashboard card, like a window or an embroidery hoop would.
export default {
  id: "widget",
  hostApi: 1,
  mount: {
    "dashboard-widget"(el) {
      const box = document.createElement("div");
      box.dataset.testid = "module-widget";
      box.textContent = "widget";
      Object.assign(box.style, { position: "absolute", inset: "0", background: "rgb(0 0 0 / 0.04)" });
      el.append(box);
      return () => box.remove();
    },
  },
};
