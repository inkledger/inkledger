// Stands on the day timeline, lights the Dashboard, and hides its desk card
// (like the Bonsai): the desk must not stay as an empty section. Its shape
// (a square at the bottom left) takes clicks; the timeline under the rest does.
export default {
  id: "perch",
  hostApi: 1,
  mount: {
    "dashboard-perch"(el, host) {
      const box = document.createElement("div");
      box.dataset.testid = "module-perch";
      Object.assign(box.style, { position: "absolute", inset: "0", background: "rgb(0 0 0 / 0.04)" });
      // A child that asks for clicks: the host's slot keeps it see-through anyway.
      const greedy = document.createElement("div");
      greedy.dataset.testid = "module-perch-greedy";
      Object.assign(greedy.style, { position: "absolute", inset: "0", pointerEvents: "auto" });
      box.append(greedy);
      el.append(box);
      // Its shape: a 40 px square at the bottom left (like the tree on its pot).
      // Only a gesture starting there is the module's; it opens its settings.
      window.__perchHits = 0;
      const unhit = host.hitArea?.(box, (x, y, w, h) => x < 40 && y > h - 40, () => {
        window.__perchHits++;
        host.openSettings?.();
      });
      host.ambient?.({ x: 0.6, y: 0.8, strength: 1.2, from: -1, tint: [255, 200, 150], veil: 0.08 });
      window.__perchSettings = () => host.openSettings?.();
      // A picture through the server cache: put, then read back.
      window.__perchFile = async () => {
        await host.files.put("tree|1", new Blob([new Uint8Array(3000).fill(9)], { type: "image/webp" }));
        const back = await host.files.get("tree|1");
        return [back?.size, back?.type, (await host.files.get("missing")) === null];
      };
      window.__perchLight = on => host.ambient?.(on ? { x: -0.5, y: 0.9, strength: 1, from: 1, tint: [200, 210, 255], veil: 0.05 } : null);
      window.__perchNight = dim => host.ambient?.({ x: -0.3, y: 1, strength: 0.5, from: 1, tint: [128, 146, 206], veil: 0.06, dim });
      return () => {
        unhit?.();
        box.remove();
      };
    },
    settings(el) {
      el.textContent = "Perch options here";
      return () => (el.textContent = "");
    },
    "dashboard-widget"(el) {
      el.hidden = true;
      return () => {};
    },
  },
};
