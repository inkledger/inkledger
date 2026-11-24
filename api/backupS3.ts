// A minimal S3 client for off-site backups: PUT, GET, LIST (v2) and DELETE of objects,
// signed with AWS Signature V4, path-style (AWS, MinIO, Backblaze B2, Wasabi, R2 and
// other S3-compatible stores take it). Calls go through the egress guard (safeFetch:
// no loopback, link-local or metadata address, no redirect to another site); a test
// passes its own transport instead.
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { assertSafeUrl, type Network } from "./lib/security";
import { safeFetch } from "./providers/core/http";
import type { Digest } from "./backupCrypto";

export type S3Config = {
  /** "https://s3.eu-central-1.amazonaws.com", "https://minio.lan:9000" */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** What sends a signed request: the egress guard in the server, an in-memory store in tests. */
export type S3Transport = (url: string, init: RequestInit & { duplex?: "half" }) => Promise<Response>;

export type S3Object = { key: string; size: number; lastModified: number };

export class S3Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** RFC 3986 encoding, as SigV4 wants it ("/" kept in keys). */
const encode = (s: string, keepSlash = false) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, "/");

const amzDate = (at: Date) => at.toISOString().replace(/[:-]|\.\d{3}/g, "");

/**
 * The Authorization and x-amz-* headers for one request (AWS Signature V4).
 * Exported for its test: a request signed here is one S3 accepts.
 */
export function signRequest(
  cfg: Pick<S3Config, "region" | "accessKeyId" | "secretAccessKey">,
  req: { method: string; url: URL; headers: Record<string, string>; payloadHash: string },
  at = new Date(),
): Record<string, string> {
  const date = amzDate(at);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = { ...req.headers, host: req.url.host, "x-amz-content-sha256": req.payloadHash, "x-amz-date": date };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const query = [...req.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [req.method, req.url.pathname, query, names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), req.payloadHash].join("\n");
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonical)].join("\n");
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, day);
  const key = hmac(hmac(hmac(kDate, cfg.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  const rest = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "host"));
  return { ...rest, Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/** The guarded transport: the endpoint checked before each call (DNS may have changed), then safeFetch. */
export function guardedTransport(endpoint: string, network: Network = "private"): S3Transport {
  return async (url, init) => {
    await assertSafeUrl(endpoint, { network });
    return safeFetch({
      site: new URL(endpoint).origin,
      url,
      network,
      init,
      fail: (status, message) => new S3Error(status, "Refused", message),
    });
  };
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

async function failure(res: Response, what: string): Promise<S3Error> {
  const body = await res.text().catch(() => "");
  const code = tag(body, "Code") ?? String(res.status);
  const message = tag(body, "Message");
  return new S3Error(res.status, code, `S3 ${what}: ${res.status} ${code}${message ? ` (${unxml(message)})` : ""}`);
}

export type ObjectLock = { mode: "GOVERNANCE" | "COMPLIANCE"; until: Date };

export function s3Client(cfg: S3Config, transport: S3Transport = guardedTransport(cfg.endpoint)) {
  const base = cfg.endpoint.replace(/\/+$/, "");
  const objectUrl = (key: string) => new URL(`${base}/${encode(cfg.bucket)}/${encode(key, true)}`);
  const bucketUrl = () => new URL(`${base}/${encode(cfg.bucket)}`);
  const send = (method: string, url: URL, init: { headers?: Record<string, string>; body?: RequestInit["body"]; payloadHash?: string } = {}) => {
    const headers = signRequest(cfg, { method, url, headers: init.headers ?? {}, payloadHash: init.payloadHash ?? sha256Hex("") });
    return transport(url.toString(), {
      method,
      headers,
      ...(init.body !== undefined ? { body: init.body, duplex: "half" as const } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(6 * 3600_000),
    });
  };
  return {
    /** Uploads a file whose digest is known (the payload is signed; Object Lock retention when asked). */
    async putFile(key: string, file: string, digest: Digest, lock?: ObjectLock): Promise<void> {
      const headers: Record<string, string> = {
        "content-length": String(digest.size),
        "content-type": "application/octet-stream",
        "content-md5": digest.md5Base64,
        "x-amz-checksum-sha256": digest.sha256Base64,
        "x-amz-sdk-checksum-algorithm": "SHA256",
      };
      if (lock) {
        headers["x-amz-object-lock-mode"] = lock.mode;
        headers["x-amz-object-lock-retain-until-date"] = lock.until.toISOString();
      }
      const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
      const res = await send("PUT", objectUrl(key), { headers, body, payloadHash: digest.sha256Hex });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw await failure(res, `PUT ${key}`);
    },
    /** The object's bytes, as they come. */
    async get(key: string): Promise<Readable> {
      const res = await send("GET", objectUrl(key));
      if (!res.ok || !res.body) throw await failure(res, `GET ${key}`);
      // A Node web stream iterates: its chunks as they come.
      return Readable.from(res.body);
    },
    /** Every object under `prefix` (all pages). */
    async list(prefix: string): Promise<S3Object[]> {
      const out: S3Object[] = [];
      let token: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const url = bucketUrl();
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (token) url.searchParams.set("continuation-token", token);
        const res = await send("GET", url);
        if (!res.ok) throw await failure(res, "LIST");
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = tag(m[1], "Key");
          if (key === undefined) continue;
          out.push({ key: unxml(key), size: Number(tag(m[1], "Size") ?? 0), lastModified: Date.parse(tag(m[1], "LastModified") ?? "") || 0 });
        }
        token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : undefined;
        if (!token) break;
        token = unxml(token);
      }
      return out;
    },
    async remove(key: string): Promise<void> {
      const res = await send("DELETE", objectUrl(key));
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok && res.status !== 404) throw await failure(res, `DELETE ${key}`);
    },
  };
}

export type S3Client = ReturnType<typeof s3Client>;
