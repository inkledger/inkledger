// Paints a scene behind the dashboard and puts one button beside its title.
export default {
  id: "scene",
  hostApi: 1,
  mount: {
    "dashboard-backdrop"(el) {
      const sky = document.createElement("div");
      sky.dataset.testid = "module-scene";
      Object.assign(sky.style, { position: "absolute", inset: "0", background: "rgb(30 90 200)" });
      el.append(sky);
      return () => sky.remove();
    },
    "dashboard-action"(el) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Look out";
      button.addEventListener("click", () => (button.dataset.clicked = "yes"));
      el.append(button);
      return () => button.remove();
    },
  },
};
