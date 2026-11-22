import { describe, expect, it } from "vitest";
import { createBroker, safeName, sniffImage, type BrokerEnv } from "./broker";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HTML = new TextEncoder().encode("<script>alert(1)</script>");

function env(active = true) {
  const got: { shared: File[]; saved: [Blob, string][]; opened: Blob[] } = { shared: [], saved: [], opened: [] };
  const e: BrokerEnv = {
    active: () => active,
    share: async f => (got.shared.push(f), true),
    download: (f, n) => void got.saved.push([f, n]),
    open: f => void got.opened.push(f),
    position: async () => ({ lat: 45.464211, lon: 9.190336 }),
  };
  return { e, got };
}

describe("brokered pictures and place", () => {
  it("knows a picture by its bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("0000ftypavif"))).toBe("image/avif");
    expect(sniffImage(HTML)).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });

  it("an HTML or SVG file passed off as a picture is never opened, saved or shared", async () => {
    const { e, got } = env();
    const b = createBroker(e);
    const fake = new Blob([HTML], { type: "image/png" });
    await expect(b.openImage(fake)).rejects.toThrow(/not a png/);
    await expect(b.download(fake, "x.png")).rejects.toThrow(/not a png/);
    await expect(b.share(fake, "x.png")).rejects.toThrow(/not a png/);
    expect(got).toEqual({ shared: [], saved: [], opened: [] });
  });

  it("a picture goes out under its proven type and a plain name", async () => {
    const { e, got } = env();
    const b = createBroker(e);
    await b.openImage(new Blob([PNG], { type: "text/html" }));
    expect(got.opened[0]?.type).toBe("image/png");
    await b.download(new Blob([PNG]), "../../evil<b>.html");
    expect(got.saved[0]?.[1]).toBe("evilb.png");
    expect(await b.share(new Blob([PNG]), "Stitch 1")).toBe(true);
    expect(got.shared[0]).toMatchObject({ name: "Stitch 1.png", type: "image/png" });
    expect(safeName("", "image/webp")).toBe("image.webp");
  });

  it("nothing without the person's gesture; the place is rounded", async () => {
    const idle = createBroker(env(false).e);
    await expect(idle.openImage(new Blob([PNG]))).rejects.toThrow(/gesture/);
    await expect(idle.here()).rejects.toThrow(/gesture/);
    expect(await createBroker(env().e).here()).toEqual({ lat: 45.46, lon: 9.19 });
  });
});
