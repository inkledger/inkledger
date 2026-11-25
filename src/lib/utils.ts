import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Custom type scale from tailwind.config.js: must not be merged as text colours. */
const twMerge = extendTailwindMerge({
  extend: {
    // Named spacings from tailwind.config.js: `h-control` and `h-full` are the same property.
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
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
