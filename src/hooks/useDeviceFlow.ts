import { useEffect, useRef, useState } from "react";
import { failureText } from "@/lib/errorText";

/** A device-code sign-in under way: the code to enter on the page given. */
export type DeviceCode = { flowId: string; userCode: string; verificationUri: string; intervalSeconds: number };

/** What an answer of the server means: ask again in `wait` seconds, stop (with an error or none), or keep the code shown while the caller moves on. */
export type DeviceFlowStep = { wait: number } | { end: string | null } | "keep";

/**
 * A sign-in by device code (GitHub, Microsoft): `begin` shows the code and opens the page where it
 * is entered; the server is then asked, as often as it says, until `step` tells the outcome. A
 * failed call ends it with its reason in `error`.
 */
export function useDeviceFlow<A>(poll: (input: { flowId: string }) => Promise<A>, step: (answer: A) => DeviceFlowStep) {
  const [flow, setFlow] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The latest callback, without restarting the wait at each render.
  const latest = useRef(step);
  useEffect(() => {
    latest.current = step;
  });
  useEffect(() => {
    if (!flow) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const ask = (seconds: number) => {
      timer = setTimeout(() => {
        void poll({ flowId: flow.flowId })
          .then(r => {
            if (stopped) return;
            const next = latest.current(r);
            if (next === "keep") return;
            if ("wait" in next) return ask(next.wait);
            setFlow(null);
            if (next.end !== null) setError(next.end);
          })
          .catch((e: unknown) => {
            if (stopped) return;
            setFlow(null);
            setError(failureText(e));
          });
      }, seconds * 1000);
    };
    ask(flow.intervalSeconds);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [flow, poll]);
  return {
    flow,
    error,
    setError,
    /** The code is there: shown, and its page opened. */
    begin: (f: DeviceCode) => {
      setFlow(f);
      window.open(f.verificationUri, "_blank", "noopener");
    },
    /** Starting failed: said. */
    fail: (e: unknown) => setError(failureText(e)),
  };
}
