/** The body, read up to `max` bytes: null past it (a declared length too big is refused before any byte). */
export async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return body;
}
