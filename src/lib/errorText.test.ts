import { TRPCClientError } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorKind, errorText, failureText, logFault, toastError, UserFacingError } from "./errorText";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastSpy } }));
vi.mock("@/i18n", () => ({ t: (k: string) => `<${k}>` }));

/** A tRPC error as the client builds it from the server's answer. */
const fromServer = (message: string, code: string) =>
  TRPCClientError.from({ error: { message, code: -32600, data: { code, httpStatus: 400 } } });

describe("errorText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    toastSpy.mockReset();
  });

  it("the server's own words are shown as they are", () => {
    const e = fromServer("Il worklog non esiste più", "NOT_FOUND");
    expect(errorKind(e)).toBe("said");
    expect(errorText(e)).toBe("Il worklog non esiste più");
  });

  it("a request that never got an answer is a network failure, in the user's words", () => {
    for (const text of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      const e = TRPCClientError.from(new TypeError(text));
      expect(errorKind(e)).toBe("network");
      expect(errorText(e)).toBe("<ui.error.network>");
      expect(errorText(new TypeError(text))).toBe("<ui.error.network>");
    }
  });

  it("offline, a failure without the server's words is a network failure", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(errorText(TRPCClientError.from(new Error("Unexpected end of JSON input")))).toBe("<ui.error.network>");
  });

  it("a timed-out request says so", () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    expect(errorText(timeout)).toBe("<ui.error.timeout>");
    expect(errorText(TRPCClientError.from(timeout))).toBe("<ui.error.timeout>");
  });

  it("a text thrown as it is (the native shell's) is shown as it is", () => {
    expect(errorKind("Nome del server non valido")).toBe("said");
    expect(errorText("Nome del server non valido")).toBe("Nome del server non valido");
  });

  it("the app's own words are shown; any other fault in general words, its details in the console when reported", () => {
    expect(errorText(new UserFacingError("Dominio non valido"))).toBe("Dominio non valido");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const faults = [new Error("Cannot read properties of undefined (reading 'x')"), TRPCClientError.from(new SyntaxError("Unexpected token '<'")), "", undefined, new DOMException("denied", "NotAllowedError")];
      for (const e of faults) expect(errorText(e)).toBe("<ui.error.failed>");
      expect(log).not.toHaveBeenCalled();
      for (const e of faults) toastError(e);
      expect(log).toHaveBeenCalledTimes(5);
      toastError(fromServer("Già fatto", "CONFLICT"));
      toastError(new TypeError("Failed to fetch"));
      expect(log).toHaveBeenCalledTimes(5);
    } finally {
      log.mockRestore();
    }
  });

  it("toastError: one toast per text at a time (a local and a shared handler both reporting it)", () => {
    toastError(fromServer("Già fatto", "CONFLICT"));
    toastError(fromServer("Già fatto", "CONFLICT"), { duration: 10_000 });
    expect(toastSpy).toHaveBeenNthCalledWith(1, "Già fatto", { id: "error:Già fatto" });
    expect(toastSpy).toHaveBeenNthCalledWith(2, "Già fatto", { id: "error:Già fatto", duration: 10_000 });
  });

  it("failureText: the same words, a fault's details to the console", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(failureText(fromServer("Password errata", "UNAUTHORIZED"))).toBe("Password errata");
      expect(log).not.toHaveBeenCalled();
      expect(failureText(new Error("x is undefined"))).toBe("<ui.error.failed>");
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it("a fault reported twice (the query cache, then a toast) is logged once", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const e = new Error("x is undefined");
      logFault(e);
      toastError(e);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it("the new-build signal is a code, never shown as words", () => {
    expect(errorKind(fromServer("APP_BUILD_CHANGED", "CONFLICT"))).toBe("other");
    expect(errorText(fromServer("APP_BUILD_CHANGED", "CONFLICT"))).toBe("<ui.error.failed>");
  });
});
