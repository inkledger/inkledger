// A framed (host API v2) demo module that saves a film through the host ("download.large"): a
// short recording of its canvas, padded past the picture cap, saved on the person's click.
export default {
  id: "film",
  hostApi: 2,
  mount: {
    "dashboard-widget"(el, host) {
      const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 64 });
      const g = canvas.getContext("2d");
      const button = Object.assign(document.createElement("button"), { textContent: "Save film", disabled: true });
      let n = 0;
      let raf = 0;
      const draw = () => {
        g.fillStyle = `hsl(${(n += 10) % 360} 60% 50%)`;
        g.fillRect(0, 0, 64, 64);
        raf = requestAnimationFrame(draw);
      };
      draw();
      const type = ["video/webm;codecs=vp9", "video/webm", "video/mp4"].find(t => MediaRecorder.isTypeSupported(t));
      const chunks = [];
      const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type });
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      let film = null;
      rec.onstop = () => {
        film = new Blob([...chunks, new Uint8Array(5 * 1024 * 1024)], { type });
        button.disabled = false;
        button.dataset.ready = type;
      };
      rec.start(100);
      // Stopped once the recorder has given its first bytes (a loaded machine may give none by 600 ms, and a film without its header isn't one).
      let stop = 0;
      const finish = () => (chunks.length ? rec.stop() : (stop = setTimeout(finish, 100)));
      stop = setTimeout(finish, 600);
      button.onclick = () => void host.downloadLarge(film, "film").then(() => (button.dataset.saved = ""), e => (button.dataset.error = e.message));
      el.append(canvas, button);
      return () => {
        rec.onstop = null;
        clearTimeout(stop);
        cancelAnimationFrame(raf);
        if (rec.state !== "inactive") rec.stop();
        el.replaceChildren();
      };
    },
  },
};
