// A ZIP written as it goes (no library): each entry deflated whole, then its header, its
// bytes and, at the end, the central directory. One entry is held at a time, never the
// archive. No ZIP64: an archive stays under 4 GiB and 65535 entries (an export is far less).
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; data: Uint8Array | string };

const LIMIT = 0xffffffff;

/** The MS-DOS time and date a ZIP keeps (local time, two-second steps). */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

type Written = { name: Uint8Array; crc: number; size: number; packed: number; offset: number };

function localHeader(e: Written, t: { time: number; date: number }): Uint8Array {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4); // version needed
  b.writeUInt16LE(0x0800, 6); // names in UTF-8
  b.writeUInt16LE(8, 8); // deflate
  b.writeUInt16LE(t.time, 10);
  b.writeUInt16LE(t.date, 12);
  b.writeUInt32LE(e.crc, 14);
  b.writeUInt32LE(e.packed, 18);
  b.writeUInt32LE(e.size, 22);
  b.writeUInt16LE(e.name.length, 26);
  b.writeUInt16LE(0, 28);
  return Buffer.concat([b, e.name]);
}

function centralHeader(e: Written, t: { time: number; date: number }): Uint8Array {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4); // made by
  b.writeUInt16LE(20, 6); // needed
  b.writeUInt16LE(0x0800, 8);
  b.writeUInt16LE(8, 10);
  b.writeUInt16LE(t.time, 12);
  b.writeUInt16LE(t.date, 14);
  b.writeUInt32LE(e.crc, 16);
  b.writeUInt32LE(e.packed, 20);
  b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(e.name.length, 28);
  // extra, comment, disk, internal attributes: 0
  b.writeUInt32LE(0o100644 * 0x10000, 38); // a regular file, rw-r--r--
  b.writeUInt32LE(e.offset, 42);
  return Buffer.concat([b, e.name]);
}

function endOfDirectory(count: number, size: number, offset: number): Uint8Array {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(size, 12);
  b.writeUInt32LE(offset, 16);
  return b;
}

/**
 * The entries as a ZIP stream, pulled one entry at a time: a slow download holds the next
 * one back. `when` dates every entry.
 */
export function zipStream(entries: AsyncIterable<ZipEntry>, when = new Date()): ReadableStream<Uint8Array> {
  const t = dosTime(when);
  const it = entries[Symbol.asyncIterator]();
  const written: Written[] = [];
  const names = new Set<string>();
  let offset = 0;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (done) return;
        const next = await it.next();
        if (next.done) {
          const directory = Buffer.concat(written.map((e) => centralHeader(e, t)));
          if (written.length > 0xffff || offset > LIMIT) throw new Error("zip: too large");
          controller.enqueue(Buffer.concat([directory, endOfDirectory(written.length, directory.length, offset)]));
          done = true;
          controller.close();
          return;
        }
        const { name, data } = next.value;
        if (!name || name.startsWith("/") || name.split("/").includes("..") || names.has(name)) throw new Error(`zip: bad entry name ${name}`);
        names.add(name);
        const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
        const packed = deflateRawSync(bytes);
        if (bytes.length > LIMIT || packed.length > LIMIT) throw new Error("zip: entry too large");
        const e: Written = { name: Buffer.from(name, "utf8"), crc: crc32(bytes) >>> 0, size: bytes.length, packed: packed.length, offset };
        const header = localHeader(e, t);
        controller.enqueue(header);
        controller.enqueue(packed);
        offset += header.length + packed.length;
        written.push(e);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await it.return?.(undefined);
    },
  });
}

/**
 * Every entry of a ZIP (stored or deflated, no ZIP64), each checked against its CRC: the
 * tests read exports back with it.
 */
export function readZip(zip: Uint8Array): { name: string; data: Buffer }[] {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("zip: no end of directory");
  const count = b.readUInt16LE(end + 10);
  let at = b.readUInt32LE(end + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(at) !== 0x02014b50) throw new Error("zip: bad directory entry");
    const method = b.readUInt16LE(at + 10);
    const crc = b.readUInt32LE(at + 16);
    const packed = b.readUInt32LE(at + 20);
    const nameLen = b.readUInt16LE(at + 28);
    const skip = nameLen + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
    const offset = b.readUInt32LE(at + 42);
    const name = b.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    if (b.readUInt32LE(offset) !== 0x04034b50) throw new Error("zip: bad local header");
    const start = offset + 30 + b.readUInt16LE(offset + 26) + b.readUInt16LE(offset + 28);
    const raw = b.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (!data) throw new Error(`zip: method ${method}`);
    if (crc32(data) >>> 0 !== crc) throw new Error(`zip: ${name} fails its CRC`);
    out.push({ name, data });
    at += 46 + skip;
  }
  return out;
}
