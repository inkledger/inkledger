// A free demo module for the e2e tests (the public repo ships no paid module):
// shows the timer state and a click counter kept in the module's storage.
export default {
  id: "hello",
  hostApi: 1,
  mount: {
    "sidebar-footer"(el, host) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.testid = "module-hello";
      let clicks = 0;
      let timer = { state: "idle" };
      const render = () => (button.textContent = `hello ${timer.state} ${clicks}`);
      const off = host.timer(t => {
        timer = t;
        render();
      });
      void host.storage.get("clicks").then(v => {
        clicks = v ?? 0;
        render();
      });
      // What the host tells (WP-17), for the tests to read.
      const heard = [];
      const offs = ["worklog-logged", "worklog-changed", "timer-stopped"].map(e => host.on(e, d => {
        heard.push({ e, ...d });
        button.dataset.heard = JSON.stringify(heard);
      }));
      button.onclick = () => {
        clicks += 1;
        render();
        void host.storage.set("clicks", clicks);
      };
      el.append(button);
      return () => {
        off();
        offs.forEach(f => f());
        button.remove();
      };
    },
  },
};
