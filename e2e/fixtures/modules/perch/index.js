// Stands on the day timeline and hides its desk card
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
      window.__perchSettings = () => host.openSettings?.();
      // A picture through the server cache: put, then read back.
      window.__perchFile = async () => {
        await host.files.put("tree|1", new Blob([new Uint8Array(3000).fill(9)], { type: "image/webp" }));
        const back = await host.files.get("tree|1");
        return [back?.size, back?.type, (await host.files.get("missing")) === null];
      };
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
