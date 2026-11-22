// A framed (host API v2) demo module for the e2e tests: runs in a sandboxed
// frame, draws in its dashboard card, asks the host for totals, round-trips a
// worker made from its own code (as the real modules do) and hears its runtime.
// Over the Dashboard it draws a square that only the host makes clickable.
if (typeof document === "undefined") self.addEventListener("message", e => self.postMessage(e.data * 2));

export default {
  id: "framed",
  hostApi: 2,
  runtime(host) {
    return host.views((port, slot) => port.postMessage(`runtime hears ${slot}`));
  },
  mount: {
    "dashboard-overlay"(el, host) {
      const dot = document.createElement("div");
      dot.dataset.testid = "framed-dot";
      Object.assign(dot.style, { position: "absolute", left: "20px", top: "20px", width: "60px", height: "60px", background: "rgb(0 0 0 / 0.1)" });
      let n = 0;
      host.hit.set([{ kind: "rect", x: 20, y: 20, w: 60, h: 60 }], () => (dot.textContent = `activated ${++n}`));
      el.append(dot);
      return () => dot.remove();
    },
    "dashboard-widget"(el, host) {
      const box = document.createElement("div");
      box.dataset.testid = "module-framed";
      const line = name => {
        const p = document.createElement("p");
        p.dataset.testid = `framed-${name}`;
        box.append(p);
        return text => (p.textContent = text);
      };
      line("hello")("framed hello");
      const timer = line("timer");
      const totals = line("totals");
      const worker = line("worker");
      const runtime = line("runtime");
      const off = host.timer(t => timer(`timer ${t.state}`));
      void host.totals().then(t => totals(`totals ${t.lifetimeLoggedSeconds}`));
      const w = new Worker(import.meta.url, { type: "module" });
      w.onmessage = e => worker(`worker ${e.data}`);
      w.postMessage(21);
      if (host.runtime) host.runtime.onmessage = e => runtime(String(e.data));
      el.append(box);
      return () => {
        off();
        w.terminate();
        box.remove();
      };
    },
  },
};
