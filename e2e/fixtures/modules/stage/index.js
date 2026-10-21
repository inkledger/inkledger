// An app-wide module (like Shadow): mounted once in the shell, it reads the
// host's surface catalog and stage, and counts its mounts (a page change must
// not mount it again). The old light call is ignored by the host.
export default {
  id: "stage",
  hostApi: 1,
  mount: {
    "app-stage"(el, host) {
      window.__stageMounts = (window.__stageMounts ?? 0) + 1;
      host.ambient?.({ x: 1, y: 1, strength: 1, from: 1, tint: [255, 255, 255], veil: 0.1 });
      window.__stage = () => ({
        catalog: host.surfaces?.catalog() ?? null,
        root: host.stage?.root()?.hasAttribute("data-surface-stage") ?? false,
        panel: host.stage?.panel()?.hasAttribute("data-surface-panel") ?? false,
      });
      const off = host.theme(t => (window.__stageNight = t.night));
      return () => {
        off();
        window.__stageMounts--;
      };
    },
  },
};
