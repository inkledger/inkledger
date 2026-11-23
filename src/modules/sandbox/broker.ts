/**
 * What a framed module hands the person through the host: a picture to
 * share, save or open, and where they are. Each needs their gesture in the
 * module's own view (gesture.ts), and a picture is re-wrapped under
 * the type its bytes prove: a blob URL made here has the app's origin, so
 * HTML or SVG passed off as a picture must never be opened from it.
 */

import { PICTURE_GESTURE_MS } from "./gesture";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
/** What MediaRecorder makes: a film saved with "download.large". */
export type VideoType = "video/webm" | "video/mp4";
const EXTENSION: Record<ImageType | VideoType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif", "video/webm": "webm", "video/mp4": "mp4" };

/** The picture type its first bytes prove, or null. */
export function sniffImage(b: Uint8Array): ImageType | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  const ascii = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftypavif") || ascii(4, "ftypavis")) return "image/avif";
  return null;
}

/** The film type its first bytes prove (WebM's EBML header, an MP4 `ftyp` box that is no picture), or null. */
export function sniffVideo(b: Uint8Array): VideoType | null {
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  const brand = String.fromCharCode(...b.slice(8, 12));
  if (String.fromCharCode(...b.slice(4, 8)) === "ftyp" && /^(iso[2-9m]|mp4[12]|avc1|M4V |dash)$/.test(brand)) return "video/mp4";
  return null;
}

/** A picture under its proven type, or null when its bytes are not one. */
export async function asImage(file: Blob): Promise<{ image: Blob; type: ImageType } | null> {
  // Its head proves the type; the rest is wrapped as it is (a 4 MB picture never copied here).
  const type = sniffImage(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  return type ? { image: new Blob([file], { type }), type } : null;
}

/** A file name a download can carry: plain characters, the picture's own extension. */
export function safeName(name: string, type: ImageType | VideoType): string {
  const stem =
    name
      .replace(/\.[^.]*$/, "")
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .trim()
      .slice(0, 60) || "image";
  return `${stem}.${EXTENSION[type]}`;
}

export type BrokerEnv = {
  /** Whether the person's gesture is still fresh (navigator.userActivation), and for a frame its own, within `ms` (gesture.ts). */
  active(ms?: number): boolean;
  share(file: File): Promise<boolean>;
  download(file: Blob, name: string): void;
  open(file: Blob): void;
  position(): Promise<{ lat: number; lon: number } | null>;
};

const NO_GESTURE = "needs the person's gesture";

export function createBroker(env: BrokerEnv) {
  const picture = async (file: Blob) => {
    // The module draws the picture first: a longer moment than a dialog's.
    if (!env.active(PICTURE_GESTURE_MS)) throw new Error(NO_GESTURE);
    const proven = await asImage(file);
    if (!proven) throw new Error("not a png, jpeg, webp or avif picture");
    return proven;
  };
  return {
    active: () => env.active(),
    async share(file: Blob, name: string): Promise<boolean> {
      const { image, type } = await picture(file);
      return env.share(new File([image], safeName(name, type), { type }));
    },
    async download(file: Blob, name: string): Promise<void> {
      const { image, type } = await picture(file);
      env.download(image, safeName(name, type));
    },
    /** A film (or a picture) past the picture cap, the same gesture rule: made before the person's click that saves it. */
    async downloadLarge(file: Blob, name: string): Promise<void> {
      if (!env.active(PICTURE_GESTURE_MS)) throw new Error(NO_GESTURE);
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const type = sniffImage(head) ?? sniffVideo(head);
      if (!type) throw new Error("not a webm or mp4 film, nor a picture");
      env.download(new Blob([file], { type }), safeName(name, type));
    },
    async openImage(file: Blob): Promise<void> {
      env.open((await picture(file)).image);
    },
    /** Rounded to about a kilometre: weather and the sky need no more. */
    async here(): Promise<{ lat: number; lon: number } | null> {
      if (!env.active()) throw new Error(NO_GESTURE);
      const p = await env.position();
      return p ? { lat: Math.round(p.lat * 100) / 100, lon: Math.round(p.lon * 100) / 100 } : null;
    },
  };
}

/** The browser's: share sheet, a download link, a new tab, the geolocation prompt. */
export const browserBroker = (): BrokerEnv => ({
  active: () => navigator.userActivation?.isActive === true,
  async share(file) {
    const data = { files: [file] };
    if (typeof navigator.share !== "function" || !navigator.canShare?.(data)) return false;
    try {
      await navigator.share(data);
      return true;
    } catch {
      return false;
    }
  },
  download(file, name) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  open(file) {
    const url = URL.createObjectURL(file);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  position: () =>
    new Promise(resolve => {
      if (!("geolocation" in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 15_000 },
      );
    }),
});
