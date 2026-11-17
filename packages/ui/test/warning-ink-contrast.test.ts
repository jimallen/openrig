// workspaces-o9o.113: amber TEXT is readable on every surface of both themes. The brand amber (--warning, hsl(40 90% 50%) on
// light) measured 2.05:1 on white, so text uses its own ink, --warning-ink (Jim, 2026-11-17: "a separate text ink"); borders
// and fills keep --warning. Measured from the shipped stylesheet's tokens, so a token edit that breaks contrast fails here.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const UI = path.resolve(__dirname, "..");
const css = readFileSync(path.join(UI, "src", "globals.css"), "utf8");

/** The `--name: H S% L%` declarations of one rule body (the first `:root {` inside @layer base, or `.dark {`). */
function tokens(selector: ":root" | ".dark"): Record<string, [number, number, number]> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  const body = css.slice(start, css.indexOf("\n}", start) + 1);
  const out: Record<string, [number, number, number]> = {};
  for (const m of body.matchAll(/^\s*--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/gm)) {
    out[m[1]!] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

function rgb([h, s, l]: [number, number, number]): [number, number, number] {
  const S = s / 100, L = l / 100, k = (n: number) => (n + h / 30) % 12, a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number];
}
function luminance(c: [number, number, number]): number {
  const lin = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const x = luminance(rgb(a)), y = luminance(rgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const SURFACES = ["background", "surface-container-lowest", "surface-container-low", "surface-container",
  "surface-container-high", "surface-container-highest"];

describe("warning ink: amber text clears WCAG AA (4.5:1) on every surface of both themes (o9o.113)", () => {
  for (const theme of [":root", ".dark"] as const) {
    it(`${theme === ":root" ? "light" : "dark"}: --warning-ink against each surface token`, () => {
      const t = tokens(theme);
      expect(t["warning-ink"], `--warning-ink is declared in ${theme}`).toBeDefined();
      for (const surface of SURFACES) {
        expect(t[surface], `${surface} is declared in ${theme}`).toBeDefined();
        const ratio = contrast(t["warning-ink"]!, t[surface]!);
        expect(ratio, `--warning-ink on --${surface} (${theme}) = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("control: the brand amber itself is below 4.5:1 on light white, which is why text has its own ink", () => {
    const t = tokens(":root");
    expect(contrast(t["warning"]!, t["surface-container-lowest"]!)).toBeLessThan(4.5);
  });
});

/** Every .ts/.tsx file under src. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

describe("no amber text class except the ink (o9o.113)", () => {
  // A class token `text-warning` with nothing after it (a variant prefix like `hover:` is still the same colour). The ink
  // is `text-warning-ink`; `text-warning-foreground` or the like would be other tokens and are not matched.
  const BARE = /(?<![\w-])text-warning(?![\w-])/g;
  const files = sourceFiles(path.join(UI, "src"));

  it("no source file uses the brand amber as a text colour", () => {
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8").split("\n").flatMap((line, i) => (line.match(BARE) ? [`${path.relative(UI, f)}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it("control: the scan sees the source tree and finds the ink where amber text is used", () => {
    expect(files.length).toBeGreaterThan(100);
    const ink = files.filter((f) => readFileSync(f, "utf8").includes("text-warning-ink"));
    expect(ink.length).toBeGreaterThan(0);
  });
});
