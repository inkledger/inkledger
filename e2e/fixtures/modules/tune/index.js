// A module with only a settings panel: a button that saves one setting (e2e/store-granted.test.mjs).
export default {
  id: "tune",
  hostApi: 1,
  mount: {
    settings(el, host) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Save level";
      button.dataset.testid = "tune-save";
      const said = document.createElement("p");
      said.dataset.testid = "tune-said";
      button.addEventListener("click", () => {
        void host.storage.set("level", 2).then(() => (said.textContent = "Saved"));
      });
      el.append(button, said);
      return () => {
        button.remove();
        said.remove();
      };
    },
  },
};
