// Checkpoints and page tokens: opaque strings only their adapter reads,
// carrying what they belong to (provider, connection, stream, format
// version; a page token also the pass it is part of). Anything else, from
// another provider, connection or stream, an older format, or garbled, is
// an "invalidCheckpoint" error: the engine then reads everything again.
import type { ProviderType } from "@contracts/providers";
import { ProviderError } from "./errors";
import type { Checkpoint, Conn, PageToken, Stream } from "../types";

type Envelope = { p: ProviderType; c: number; s: Stream; v: number; d: unknown };
type PageEnvelope = Envelope & { since: string | null };

const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");

function decode<T>(text: string, prefix: string): T {
  if (!text.startsWith(prefix)) throw new ProviderError("invalidCheckpoint", "Not a checkpoint of this kind");
  try {
    return JSON.parse(Buffer.from(text.slice(prefix.length), "base64url").toString("utf8")) as T;
  } catch (cause) {
    throw new ProviderError("invalidCheckpoint", "Unreadable checkpoint", { cause });
  }
}

function check(e: Envelope, conn: Pick<Conn, "type" | "id">, stream: Stream, version: number) {
  if (e.p !== conn.type || e.c !== conn.id || e.s !== stream) {
    throw new ProviderError("invalidCheckpoint", `Checkpoint of another provider, connection or stream (${e.p}/${e.c}/${e.s})`);
  }
  if (e.v !== version) throw new ProviderError("invalidCheckpoint", `Checkpoint format v${e.v}, adapter reads v${version}`);
}

/** A checkpoint for this connection's stream, in the adapter's format `version`. */
export function encodeCheckpoint(conn: Pick<Conn, "type" | "id">, stream: Stream, version: number, data: unknown): Checkpoint {
  return `cp1.${encode({ p: conn.type, c: conn.id, s: stream, v: version, d: data } satisfies Envelope)}` as Checkpoint;
}

/** The data of a checkpoint, null for none; invalidCheckpoint when it isn't this stream's, current format. */
export function decodeCheckpoint<T>(conn: Pick<Conn, "type" | "id">, stream: Stream, version: number, cp: Checkpoint | null): T | null {
  if (cp === null) return null;
  const e = decode<Envelope>(cp, "cp1.");
  check(e, conn, stream, version);
  return e.d as T;
}

/** A token for the next page of the pass that started at `since`. */
export function encodePageToken(conn: Pick<Conn, "type" | "id">, stream: Stream, version: number, since: Checkpoint | null, data: unknown): PageToken {
  return `pg1.${encode({ p: conn.type, c: conn.id, s: stream, v: version, d: data, since } satisfies PageEnvelope)}` as PageToken;
}

/** The data of a page token, null for the first page; invalidCheckpoint when it belongs to another pass. */
export function decodePageToken<T>(conn: Pick<Conn, "type" | "id">, stream: Stream, version: number, since: Checkpoint | null, page: PageToken | null): T | null {
  if (page === null) return null;
  const e = decode<PageEnvelope>(page, "pg1.");
  check(e, conn, stream, version);
  if (e.since !== since) throw new ProviderError("invalidCheckpoint", "Page token of another pass");
  return e.d as T;
}
