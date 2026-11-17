// workspaces-o9o.118: the package install stepper's inactive steps ([ 2 VALIDATE ] ... [ 5 APPLY ] before they are reached) are
// readable: their text, the muted ink at the opacity StepIndicator gives it, clears WCAG AA (4.5:1) on the page background in both
// themes. Measured in the twin before (text-foreground-muted/30): 1.55:1 light, 1.82:1 dark. The opacity is read from the source,
// so the test follows the class, and the colours from the shipped stylesheet's tokens.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const UI = path.resolve(__dirname, "..");
const css = readFileSync(path.join(UI, "src", "globals.css"), "utf8");
const flow = readFileSync(path.join(UI, "src", "components", "PackageInstallFlow.tsx"), "utf8");

type Hsl = [number, number, number];
function tokens(selector: ":root" | ".dark"): Record<string, Hsl> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("\n}", start) + 1);
  const out: Record<string, Hsl> = {};
  for (const m of body.matchAll(/^\s*--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/gm)) out[m[1]!] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}
function rgb([h, s, l]: Hsl): number[] {
  const S = s / 100, L = l / 100, k = (n: number) => (n + h / 30) % 12, a = S * Math.min(L, 1 - L);
  return [0, 8, 4].map((n) => Math.round((L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255));
}
function luminance(c: number[]): number {
  const lin = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}
/** Contrast of `ink` drawn at `alpha` over `bg`: the colour the eye sees is the blend. */
function contrastAt(ink: Hsl, alpha: number, bg: Hsl): number {
  const f = rgb(ink), b = rgb(bg);
  const seen = f.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha)));
  const x = luminance(seen), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The opacity (0-1) of the inactive step's text-foreground-muted class inside StepIndicator; 1 when it has none. */
function inactiveAlpha(): number {
  const start = flow.indexOf("function StepIndicator(");
  const body = flow.slice(start, flow.indexOf("\n}\n", start));
  const inactive = /isActive \? [^:]+:\s*"(text-foreground-muted(?:\/(\d+))?)"/.exec(body);
  if (!inactive) throw new Error("StepIndicator's inactive step class was not found");
  return inactive[2] ? Number(inactive[2]) / 100 : 1;
}

describe("the install stepper's inactive steps are readable (o9o.118)", () => {
  for (const [theme, name] of [[":root", "light"], [".dark", "dark"]] as const) {
    it(`${name}: the inactive step text on --background clears 4.5:1`, () => {
      const t = tokens(theme);
      const ratio = contrastAt(t["on-surface-variant"]!, inactiveAlpha(), t["background"]!);
      expect(ratio, `inactive step (${name}) = ${ratio.toFixed(2)} at opacity ${inactiveAlpha()}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("control: at the old 30% the same measure is far below 4.5:1 in both themes (the instrument sees the failure)", () => {
    for (const theme of [":root", ".dark"] as const) {
      const t = tokens(theme);
      expect(contrastAt(t["on-surface-variant"]!, 0.3, t["background"]!)).toBeLessThan(2);
    }
  });
});
