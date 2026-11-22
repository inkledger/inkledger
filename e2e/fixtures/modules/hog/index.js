// A deliberately bad framed module for the watchdog's e2e test: in its card it
// burns the thread in long loops and redraws a large canvas on every frame,
// whatever budget the host sets. It shows the budget it was given.
export default {
  id: "hog",
  hostApi: 2,
  mount: {
    "dashboard-widget"(el, host) {
      const budget = document.createElement("p");
      budget.dataset.testid = "hog-budget";
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2048;
      const g = canvas.getContext("2d");
      el.append(budget, canvas);
      const off = host.budget(b => (budget.textContent = `budget ${b}`));
      // 300 ms of every 400: long tasks, all of them its own.
      const busy = setInterval(() => {
        const end = performance.now() + 300;
        while (performance.now() < end);
      }, 400);
      let raf = 0;
      const draw = t => {
        g.fillStyle = `hsl(${t % 360} 50% 50%)`;
        g.fillRect(0, 0, canvas.width, canvas.height);
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
      return () => {
        off();
        clearInterval(busy);
        cancelAnimationFrame(raf);
        el.replaceChildren();
      };
    },
  },
};
