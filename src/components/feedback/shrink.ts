/** What a screenshot may weigh to be shared with inkledger's developers (their inbox's limit). */
export const SHARE_SCREENSHOT_BYTES = 300 * 1024;
/** What may be picked at all: it is made smaller here before it is sent. */
export const PICK_MAX_BYTES = 20 * 1024 * 1024;

/**
 * A picture made small enough to share (≤ 300 KB): drawn again on a canvas, its longest side
 * at most 1920 px then smaller each try, as WebP (JPEG where the browser can't write WebP). The
 * browser's own encoders: no library. Already small enough, it stays as it is; null when no
 * try gets there.
 */
export async function shrinkScreenshot(file: File, max = SHARE_SCREENSHOT_BYTES): Promise<File | null> {
  if (file.size <= max) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    let scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    for (let i = 0; i < 6; i++, scale *= 0.75) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const type of ["image/webp", "image/jpeg"]) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.8));
        // A browser that can't write the type answers PNG: try the next one.
        if (blob && blob.type === type && blob.size <= max) return new File([blob], type === "image/webp" ? "screenshot.webp" : "screenshot.jpg", { type });
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}
