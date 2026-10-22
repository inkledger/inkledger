// A port for a test server: nobody listens on it (the Docker stacks bind 127.0.0.1,
// the server binds every address), and it sits below the range the system hands out
// to outgoing connections, so another test's browser or database client can't take
// it between this check and the server's start.
import { createServer } from "node:net";

const LOW = 20000;
const HIGH = 32000;

const free = (port, host) =>
  new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });

export async function freePort() {
  for (let i = 0; i < 200; i++) {
    const port = LOW + Math.floor(Math.random() * (HIGH - LOW));
    if ((await free(port, "127.0.0.1")) && (await free(port, "::"))) return port;
  }
  throw new Error(`no free port between ${LOW} and ${HIGH}`);
}
