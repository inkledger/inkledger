/**
 * The app's look inside a framed module: CSS variables and fonts don't
 * cross into a frame, so the host sends its design tokens as they resolve
 * now (light or dark), the root font size (density) and the app's fonts as
 * data URLs (the frame may load no font from anywhere).
 */

/** The design tokens of src/index.css's :root (a test keeps this list whole). */
export const THEME_TOKENS = [
  "--canvas",
  "--background",
  "--card",
  "--popover",
  "--foreground",
  "--card-foreground",
  "--popover-foreground",
  "--muted",
  "--secondary",
  "--secondary-foreground",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--primary",
  "--primary-foreground",
  "--primary-strong",
  "--primary-soft",
  "--ring",
  "--action",
  "--action-foreground",
  "--chart-focus",
  "--chart-other",
  "--chart-break",
  "--chart-ink",
  "--cover-ink",
  "--shadow-color",
  "--night-shadow",
  "--night-moon",
  "--overlay",
  "--project-1",
  "--project-2",
  "--project-3",
  "--project-4",
  "--project-5",
  "--project-6",
  "--cover-0-a",
  "--cover-0-b",
  "--cover-0-c",
  "--cover-0-bg",
  "--cover-1-a",
  "--cover-1-b",
  "--cover-1-c",
  "--cover-1-bg",
  "--cover-2-a",
  "--cover-2-b",
  "--cover-2-c",
  "--cover-2-bg",
  "--cover-3-a",
  "--cover-3-b",
  "--cover-3-c",
  "--cover-3-bg",
  "--cover-4-a",
  "--cover-4-b",
  "--cover-4-c",
  "--cover-4-bg",
  "--cover-5-a",
  "--cover-5-b",
  "--cover-5-c",
  "--cover-5-bg",
  "--sunset-1",
  "--sunset-2",
  "--sunset-3",
  "--sunset-4",
  "--sunset-5",
  "--cover-title",
  "--radius",
  "--danger",
  "--danger-soft",
  "--destructive",
  "--destructive-foreground",
  "--success",
  "--success-soft",
  "--warning",
  "--warning-soft",
  "--info",
  "--info-soft",
  "--qr",
  "--qr-ink",
  "--paper",
  "--tape-1",
  "--tape-2",
  "--tape-3",
  "--tape-4",
  "--tape-5",
  "--string",
] as const;

/** Only a value the app itself would write: nothing that could end the rule. */
const plain = (v: string) => !/[{}<;]/.test(v);

export type ThemeLook = { token(name: string): string; fontFamily: string; fontSize: string };

/** The stylesheet a frame gets for the app's look now. No color-scheme: a frame's differing from its element paints it opaque. */
export function themeSheet(look: ThemeLook): string {
  const vars = THEME_TOKENS.map(n => [n, look.token(n).trim()] as const)
    .filter(([, v]) => v !== "" && plain(v))
    .map(([n, v]) => `${n}:${v}`);
  const font = plain(look.fontFamily) ? `font-family:${look.fontFamily};` : "";
  const size = /^\d+(\.\d+)?px$/.test(look.fontSize) ? `font-size:${look.fontSize};` : "";
  return `:root{${vars.join(";")}}html{${size}}body{${font}}`;
}

export type FontFile = { family: string; url: string };

/** @font-face rules for the app's (variable, latin) fonts, their bytes inline. */
export function fontFaces(fonts: readonly { family: string; data: string }[]): string {
  return fonts
    .filter(f => /^data:font\/woff2;base64,[A-Za-z0-9+/=]+$/.test(f.data) && /^[\w ]+$/.test(f.family))
    .map(f => `@font-face{font-family:'${f.family}';font-style:normal;font-display:swap;font-weight:100 900;src:url(${f.data}) format('woff2-variations')}`)
    .join("\n");
}

/** Fetched and encoded once for every frame of the page. */
export function fontLoader(files: readonly FontFile[], read: (url: string) => Promise<Blob>) {
  let loaded: Promise<string | null> | null = null;
  const dataUrl = async (b: Blob) => {
    const bytes = new Uint8Array(await b.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:font/woff2;base64,${btoa(s)}`;
  };
  return () =>
    (loaded ??= Promise.all(files.map(async f => ({ family: f.family, data: await dataUrl(await read(f.url)) })))
      .then(fontFaces)
      .catch(() => {
        loaded = null;
        return null;
      }));
}
