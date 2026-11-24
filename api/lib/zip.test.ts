import { describe, it, expect } from "vitest";
import { readZip, zipStream, type ZipEntry } from "./zip";

async function* entries(list: ZipEntry[]) {
  for (const e of list) yield e;
}

const bytesOf = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer());

describe("zip", () => {
  it("reads back what it wrote, names in UTF-8, empty files and binary included", async () => {
    const bin = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    const zip = await bytesOf(zipStream(entries([{ name: "a.json", data: '{"a":1}' }, { name: "dir/è.csv", data: "" }, { name: "bin", data: bin }])));
    const out = readZip(zip);
    expect(out.map((e) => e.name)).toEqual(["a.json", "dir/è.csv", "bin"]);
    expect(out[0].data.toString()).toBe('{"a":1}');
    expect(out[1].data.length).toBe(0);
    expect(Buffer.compare(out[2].data, Buffer.from(bin))).toBe(0);
  });

  it("refuses a name that climbs out, or comes twice", async () => {
    await expect(bytesOf(zipStream(entries([{ name: "../x", data: "" }])))).rejects.toThrow(/bad entry name/);
    await expect(bytesOf(zipStream(entries([{ name: "x", data: "" }, { name: "x", data: "" }])))).rejects.toThrow(/bad entry name/);
  });

  it("an archive with nothing in it is still one", async () => {
    expect(readZip(await bytesOf(zipStream(entries([]))))).toEqual([]);
  });
});
