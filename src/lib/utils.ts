import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Custom type scale (index.css's @theme): must not be merged as text colours. */
const twMerge = extendTailwindMerge({
  extend: {
    // Named spacings (index.css's @theme): `h-control` and `h-full` are the same property.
    theme: { spacing: ["control", "touch", "target"] },
    classGroups: {
      "font-size": [
        {
          text: [
            "display",
            "title",
            "heading",
            "body",
            "body-sm",
            "caption",
            "overline",
            "2xs",
          ],
        },
      ],
      // index.css's outline-clear (the app's "no outline") is an outline style, as outline-none was.
      "outline-style": [{ outline: ["clear"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
