import tailwindcss from "@tailwindcss/postcss";

/**
 * Our colour tokens are HSL channels (--primary: 12 55% 47%). Tailwind 4 fades one (bg-primary/40) as
 * color-mix(in oklab, hsl(var(--primary)) 40%, transparent), which paints some token and alpha pairs a
 * channel step off hsl(var(--primary) / 40%), what Tailwind 3 wrote (white and black too: bg-white/70
 * was rgb(255 255 255 / 0.7)). Written back as that alpha, a faded colour paints exactly as it always
 * has (the high-contrast look is approved to the pixel).
 */
const FADE = /color-mix\(in oklab,\s*(hsl\(var\(--[\w-]+\)\)|var\(--color-(?:white|black)\))\s+([\d.]+%),\s*transparent\)/g;
const RGB = { "var(--color-white)": "255 255 255", "var(--color-black)": "0 0 0" };
const faded = (color, alpha) => (RGB[color] ? `rgb(${RGB[color]} / ${alpha})` : color.replace(/\)\)$/, `) / ${alpha})`));
const hslFades = {
  postcssPlugin: "hsl-fades",
  OnceExit(root) {
    root.walkDecls(decl => {
      if (decl.value.includes("color-mix(")) decl.value = decl.value.replace(FADE, (_, color, alpha) => faded(color, alpha));
    });
  },
};

export default {
  plugins: [
    // No Lightning CSS pass: Vite minifies the page's CSS as it always did. (Lightning rounded colours such as
    // hsl(0 0% 100% / .35) to #ffffff59, a step off on the paper notes.)
    tailwindcss({ optimize: false }),
    hslFades,
  ],
};
