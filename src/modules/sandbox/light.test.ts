import { describe, expect, it } from "vitest";
import { SURFACES } from "@/components/app/surface";
import { LIGHT_NAMES, createPageLight, lightRules, lightValue, parseLight, type LightName } from "./light";

// Values as the Shadow module writes them.
const GOOD: [LightName, string, string][] = [
  ["--sh-1", "0 0 #0000", "0 0 #0000"],
  [
    "--sh-1",
    "0px 0.5px 1px 0 hsl(var(--shadow-color) / 0.18), 0.75px 1.5px 4px -1px hsl(var(--shadow-color) / 0.26)",
    "0px 0.5px 1px 0px hsl(var(--shadow-color) / 0.18), 0.75px 1.5px 4px -1px hsl(var(--shadow-color) / 0.26)",
  ],
  ["--sh-3", "-2.25px 9px 20px -6px hsl(var(--night-shadow) / 0.6)", "-2.25px 9px 20px -6px hsl(var(--night-shadow) / 0.6)"],
  ["--sh-drop-2", "drop-shadow(-1.5px 3px 5px hsl(var(--night-shadow) / 0.3))", "drop-shadow(-1.5px 3px 5px hsl(var(--night-shadow) / 0.3))"],
  ["--sh-drop-1", "none", "none"],
  ["--sh-edge", "inset 0 1px 0 hsl(0 0% 100% / 0.85)", "inset 0px 1px 0px hsl(0 0% 100% / 0.85)"],
  ["--sky-dim", "0.36", "0.36"],
  ["--sky-dim", "0", "0"],
];

const BAD: [string, string][] = [
  ["--sh-1", "0 0 10px url(https://x.test/a.png)"],
  ["--sh-1", "0 0 4px hsl(var(--primary) / 0.2)"],
  ["--sh-1", "0 0 4px var(--shadow-color)"],
  ["--sh-1", "0 0 4px hsl(var(--shadow-color) / 0.2); color: red"],
  ["--sh-1", "0 0 4px hsl(var(--shadow-color) / 0.2)}body{display:none"],
  ["--sh-1", "\\75 rl(x)"],
  ["--sh-1", "0 0 4px red"],
  ["--sh-1", "0 0 -4px hsl(var(--shadow-color) / 0.2)"],
  ["--sh-1", "0 0 4px 1px 2px hsl(var(--shadow-color) / 0.2)"],
  ["--sh-1", "0 0 4em hsl(var(--shadow-color) / 0.2)"],
  ["--sh-1", "9999px 0 4px hsl(var(--shadow-color) / 0.2)"],
  ["--sh-1", "0 0 4px hsl(var(--shadow-color) / 2)"],
  ["--sh-1", Array(5).fill("0 0 1px hsl(0 0% 0% / 0.1)").join(", ")],
  ["--sh-1", "0 0 1px hsl(0 0% 0% / 0.1)," + " ".repeat(600)],
  ["--sh-drop-1", "drop-shadow(0 0 4px hsl(var(--shadow-color) / 0.2)) blur(4px)"],
  ["--sh-drop-1", "0 0 4px hsl(var(--shadow-color) / 0.2)"],
  ["--sky-dim", "1.5"],
  ["--sky-dim", "calc(1)"],
  ["--sky-dim", ""],
];

describe("surfaces.light: the grammar", () => {
  it.each(GOOD)("takes %s: %s", (name, value, canonical) => {
    expect(lightValue(name, value)).toBe(canonical);
  });

  it.each(BAD)("refuses %s: %s", (name, value) => {
    expect(parseLight({ [name]: value })).toEqual({ ok: false, name });
  });

  it("only the shadow variables", () => {
    expect(parseLight({ "--primary": "0" })).toEqual({ ok: false, name: "--primary" });
    expect(parseLight({ color: "0" })).toEqual({ ok: false, name: "color" });
    expect(parseLight({ "--sky-dim": 0.3 })).toEqual({ ok: false, name: "--sky-dim" });
    expect(parseLight({ "--sky-dim": "0.3", "--sh-1": "0 0 #0000" })).toEqual({ ok: true, light: { "--sky-dim": "0.3", "--sh-1": "0 0 #0000" } });
  });

  it("fuzz: whatever it takes, it writes back only its own canonical text", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const PIECES = ["0", "1px", "-2.5px", "4px", "0.3", "100%", "0%", "hsl(", "var(", "--shadow-color", "--night-shadow", "--primary", ")", "/", ",", " ", "inset", "none", "drop-shadow(", "#0000", "url(", ";", "}", "\\", "e", "x", "\"", "<", "calc(", "  "];
    const accepted: string[] = [];
    for (let i = 0; i < 20000; i++) {
      const name: LightName = LIGHT_NAMES[rand(LIGHT_NAMES.length)] ?? "--sh-1";
      const base = rand(3) === 0 ? (GOOD[rand(GOOD.length)]?.[1] ?? "") : "";
      let s = base;
      for (let k = rand(14); k > 0; k--) {
        const at = rand(s.length + 1);
        s = s.slice(0, at) + (PIECES[rand(PIECES.length)] ?? "") + s.slice(at);
      }
      const out = lightValue(name, s);
      if (out === null) continue;
      accepted.push(out);
      expect(out).toMatch(/^[0-9a-z.,()%/# -]*$/);
      expect(out).not.toMatch(/url|calc|--primary|;|[{}<\\"]/);
      expect(out.length).toBeLessThanOrEqual(512);
      expect(lightValue(name, out)).toBe(out);
    }
    expect(accepted.length).toBeGreaterThan(50);
  });
});

describe("surfaces.light: on the page", () => {
  const fakeDoc = () => {
    const props = new Map<string, string>();
    const writes: string[] = [];
    const styles: { css: string; removed: boolean; remove(): void }[] = [];
    const doc = {
      root: {
        setProperty: (k: string, v: string) => void (writes.push(k), props.set(k, v)),
        removeProperty: (k: string) => void props.delete(k),
      },
      addStyle: (css: string) => {
        const s = { css, removed: false, remove: () => void (s.removed = true) };
        styles.push(s);
        return s;
      },
    };
    return { doc, props, writes, styles };
  };

  it("draws on the catalog's surfaces only, from the host's own rules", () => {
    const css = lightRules(SURFACES);
    expect(css).toContain('[data-surface="card"][data-elev="2"]{box-shadow:');
    expect(css).toContain('[data-surface="picture"][data-elev="1"]{filter:var(--sh-drop-1)}');
    expect(css).not.toContain('"glass"');
    expect(css).not.toContain('"note"');
  });

  it("one module casts at a time, only changes are written, and its frame going clears it", () => {
    const { doc, props, writes, styles } = fakeDoc();
    const light = createPageLight(doc, SURFACES);
    const a = {};
    expect(light.set("shadow", a, { "--sky-dim": "0.2", "--sh-1": "0 0 #0000" })).toBe(true);
    expect(styles).toHaveLength(1);
    expect(light.set("other", {}, { "--sky-dim": "1" })).toBe(false);
    expect(light.set("other", {}, null)).toBe(false);
    light.set("shadow", a, { "--sky-dim": "0.3", "--sh-1": "0 0 #0000" });
    expect(writes).toEqual(["--sky-dim", "--sh-1", "--sky-dim"]);
    expect(styles).toHaveLength(1);
    light.release({});
    expect(props.get("--sky-dim")).toBe("0.3");
    light.release(a);
    expect(props.size).toBe(0);
    expect(styles[0]?.removed).toBe(true);
    expect(light.set("other", {}, { "--sky-dim": "1" })).toBe(true);
  });
});
