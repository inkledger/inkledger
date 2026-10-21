// One module in every new slot: settings, the folded rail, the phone's More sheet and dock.
const mounts = (window.__kitMounts ??= {});
const box = (slot, text, style = {}) => el => {
  mounts[slot] = (mounts[slot] ?? 0) + 1;
  if (slot === "mobile-dock") el.dataset.docked = "";
  const node = document.createElement(slot === "mobile-dock" ? "button" : "div");
  node.dataset.testid = `kit-${slot}`;
  node.textContent = text;
  Object.assign(node.style, style);
  el.append(node);
  return () => {
    mounts[slot] -= 1;
    node.remove();
  };
};
export default {
  id: "kit",
  hostApi: 1,
  mount: {
    settings(el, host) {
      const off = box("settings", "Kit settings")(el);
      void host.weather({ lat: 45.46, lon: 9.19 }).then(w => (el.dataset.weather = JSON.stringify(w)));
      return off;
    },
    "sidebar-footer"(el, host) {
      const off = box("sidebar-footer", "Kit footer")(el);
      // Saves often, like a real module: a write may land after the licence is gone.
      const t = setInterval(() => void host.storage.set("tick", Date.now()), 40);
      return () => {
        clearInterval(t);
        void host.storage.set("tick", Date.now());
        off();
      };
    },
    "sidebar-rail": box("sidebar-rail", "K"),
    "mobile-more": box("mobile-more", "Kit row"),
    "mobile-dock": box("mobile-dock", "Kit dock", {
      position: "absolute", right: "0", bottom: "8px", pointerEvents: "auto", whiteSpace: "nowrap",
    }),
  },
};
