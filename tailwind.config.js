/** @type {import('tailwindcss').Config} */

/** Colour token with alpha support: `bg-primary/40` etc. */
const token = name => `hsl(var(--${name}) / <alpha-value>)`;

/**
 * Two soft layers tinted with the theme's --shadow-color. (A module's light on
 * the Dashboard adds its own layers on top: src/modules/light.ts.)
 */
const layer = (y, b, a) => `0 ${y}px ${b}px hsl(var(--shadow-color) / ${a})`;
const shadow = (y1, b1, a1, y2, b2, a2) => `${layer(y1, b1, a1)}, ${layer(y2, b2, a2)}`;

module.exports = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', "system-ui", "sans-serif"],
        display: [
          '"Inter Tight Variable"',
          '"Inter Variable"',
          "system-ui",
          "sans-serif",
        ],
      },
      // The only type scale (rem: follows the density setting; Tailwind's
      // text-xs/sm/base/... are banned by scripts/check-design.mjs). Pair display sizes
      // with `font-display`; see PageHeader / PanelSection.
      fontSize: {
        display: [
          "2.75rem",
          { lineHeight: "1.05", letterSpacing: "-0.03em", fontWeight: "600" },
        ],
        title: [
          "1.75rem",
          { lineHeight: "1.15", letterSpacing: "-0.02em", fontWeight: "600" },
        ],
        heading: [
          "1.375rem",
          { lineHeight: "1.25", letterSpacing: "-0.015em", fontWeight: "600" },
        ],
        body: ["1rem", { lineHeight: "1.5" }],
        "body-sm": ["0.875rem", { lineHeight: "1.45" }],
        caption: ["0.8125rem", { lineHeight: "1.35" }],
        // Never below 11px, whatever the density (WCAG-friendly minimum).
        "2xs": ["max(11px, 0.625rem)", { lineHeight: "1", fontWeight: "600" }],
        overline: [
          "max(11px, 0.6875rem)",
          { lineHeight: "1.3", letterSpacing: "0.04em", fontWeight: "600" },
        ],
      },
      colors: {
        canvas: token("canvas"),
        qr: { DEFAULT: token("qr"), ink: token("qr-ink") },
        overlay: token("overlay"),
        action: { DEFAULT: token("action"), foreground: token("action-foreground") },
        "cover-ink": token("cover-ink"),
        "cover-title": token("cover-title"),
        success: { DEFAULT: token("success"), soft: token("success-soft") },
        warning: { DEFAULT: token("warning"), soft: token("warning-soft") },
        danger: { DEFAULT: token("danger"), soft: token("danger-soft") },
        info: { DEFAULT: token("info"), soft: token("info-soft") },
        chart: {
          focus: token("chart-focus"),
          other: token("chart-other"),
          break: token("chart-break"),
          ink: token("chart-ink"),
        },
        // Stable per-project data colours (src/lib/projectColors.ts).
        project: {
          1: token("project-1"),
          2: token("project-2"),
          3: token("project-3"),
          4: token("project-4"),
          5: token("project-5"),
          6: token("project-6"),
        },
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
        background: token("background"),
        foreground: token("foreground"),
        primary: {
          DEFAULT: token("primary"),
          foreground: token("primary-foreground"),
          soft: token("primary-soft"),
          /** Accent text / dots on cards (AA on card), derived per theme */
          strong: token("primary-strong"),
        },
        secondary: {
          DEFAULT: token("secondary"),
          foreground: token("secondary-foreground"),
        },
        destructive: {
          DEFAULT: token("destructive"),
          foreground: token("destructive-foreground"),
        },
        muted: {
          DEFAULT: token("muted"),
          foreground: token("muted-foreground"),
        },
        accent: {
          DEFAULT: token("accent"),
          foreground: token("accent-foreground"),
        },
        popover: {
          DEFAULT: token("popover"),
          foreground: token("popover-foreground"),
        },
        card: { DEFAULT: token("card"), foreground: token("card-foreground") },
      },
      // Radius scale tied to --radius (0.75rem): panel 2xl, card xl, control lg/md, chip sm.
      // Restrained radius scale (Linear / Geist): chip 4, control 6, group 8,
      // card 10, panel & dialog 12 — at 16px root; scales with density.
      borderRadius: {
        "2xl": "calc(var(--radius) + 0.25rem)",
        xl: "calc(var(--radius) + 0.125rem)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 0.125rem)",
        sm: "calc(var(--radius) - 0.25rem)",
        xs: "calc(var(--radius) - 0.3125rem)",
      },
      boxShadow: {
        xs: shadow(1, 1, 0.04, 0, 0, 0),
        sm: shadow(1, 1, 0.04, 1, 2, 0.04),
        DEFAULT: shadow(1, 1, 0.04, 1, 2, 0.04),
        md: shadow(1, 2, 0.05, 4, 10, 0.05),
        lg: shadow(2, 6, 0.06, 12, 28, 0.08),
        xl: shadow(4, 12, 0.07, 20, 48, 0.12),
      },
      spacing: {
        4.5: "1.125rem",
        // A finger's target (44 px, platform guidance), whatever the type density: px, not rem.
        touch: "44px",
      },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(.2,.8,.2,1)",
        out: "cubic-bezier(.2,.8,.2,1)",
      },
      transitionDuration: {
        DEFAULT: "180ms",
        fast: "120ms",
        slow: "260ms",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "page-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "none" },
        },
        shimmer: {
          from: { backgroundPosition: "-200% 0" },
          to: { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "page-in": "page-in 260ms cubic-bezier(.2,.8,.2,1) both",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    // coarse: a touch screen (a finger, not a mouse): bigger tap areas, same look.
    ({ addVariant }) => addVariant("coarse", "@media (pointer: coarse)"),
  ],
};
