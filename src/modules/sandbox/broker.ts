/**
 * What a framed module hands the person through the host: a picture to
 * share, save or open, and where they are. Each needs their gesture in the
 * module's own view (gesture.ts), and a picture is re-wrapped under
 * the type its bytes prove: a blob URL made here has the app's origin, so
 * HTML or SVG passed off as a picture must never be opened from it.
 */

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
const EXTENSION: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif" };

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

/** A picture under its proven type, or null when its bytes are not one. */
export async function asImage(file: Blob): Promise<{ image: Blob; type: ImageType } | null> {
  // Its head proves the type; the rest is wrapped as it is (a 4 MB picture never copied here).
  const type = sniffImage(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  return type ? { image: new Blob([file], { type }), type } : null;
}

/** A file name a download can carry: plain characters, the picture's own extension. */
export function safeName(name: string, type: ImageType): string {
  const stem =
    name
      .replace(/\.[^.]*$/, "")
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .trim()
      .slice(0, 60) || "image";
  return `${stem}.${EXTENSION[type]}`;
}

export type BrokerEnv = {
  /** Whether the person's gesture is still fresh (navigator.userActivation), and for a frame its own (gesture.ts). */
  active(): boolean;
  share(file: File): Promise<boolean>;
  download(file: Blob, name: string): void;
  open(file: Blob): void;
  position(): Promise<{ lat: number; lon: number } | null>;
};

const NO_GESTURE = "needs the person's gesture";

export function createBroker(env: BrokerEnv) {
  const picture = async (file: Blob) => {
    if (!env.active()) throw new Error(NO_GESTURE);
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
