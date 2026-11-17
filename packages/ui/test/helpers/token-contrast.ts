// Contrast of the shipped stylesheet's colour tokens (WCAG 2 relative luminance), read straight from src/globals.css, so a token
// edit that breaks contrast fails a test. workspaces-o9o.117; the same measure as test/warning-ink-contrast.test.ts (o9o.113/115).
import { readFileSync } from "node:fs";
import path from "node:path";

export type Hsl = [number, number, number];

const css = readFileSync(path.resolve(__dirname, "..", "..", "src", "globals.css"), "utf8");

/** The `--name: H S% L%` declarations of one rule body (the first `:root {`, or `.dark {`). */
export function tokens(selector: ":root" | ".dark"): Record<string, Hsl> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  const body = css.slice(start, css.indexOf("\n}", start) + 1);
  const out: Record<string, Hsl> = {};
  for (const m of body.matchAll(/^\s*--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/gm)) {
    out[m[1]!] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

function rgb([h, s, l]: Hsl): [number, number, number] {
  const S = s / 100, L = l / 100, k = (n: number) => (n + h / 30) % 12, a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [number, number, number];
}

function luminance(c: [number, number, number]): number {
  const lin = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

export function contrast(a: Hsl, b: Hsl): number {
  const x = luminance(rgb(a)), y = luminance(rgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export const WHITE: Hsl = [0, 0, 100];
