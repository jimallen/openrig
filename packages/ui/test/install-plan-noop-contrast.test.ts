// workspaces-o9o.119: the install plan's 'noop' policy status is readable: the muted ink at the opacity policyStatusColor gives it
// clears WCAG AA (4.5:1) on the page background in both themes (a noop row has no tint). Measured in the twin before
// (text-foreground-muted/50, /packages/install driven to its plan): 2.16:1 light, 2.94:1 dark. The opacity is read from the source.
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

/** The opacity (0-1) of the 'noop' policy status's text-foreground-muted class in policyStatusColor; 1 when it has none. */
function noopAlpha(): number {
  const start = flow.indexOf("function policyStatusColor(");
  const body = flow.slice(start, flow.indexOf("\n}\n", start));
  const noop = /case "noop": return "(text-foreground-muted(?:\/(\d+))?)";/.exec(body);
  if (!noop) throw new Error("policyStatusColor's noop class was not found");
  return noop[2] ? Number(noop[2]) / 100 : 1;
}

describe("the install plan's noop policy status is readable (o9o.119)", () => {
  for (const [theme, name] of [[":root", "light"], [".dark", "dark"]] as const) {
    it(`${name}: the noop status text on --background clears 4.5:1`, () => {
      const t = tokens(theme);
      const ratio = contrastAt(t["on-surface-variant"]!, noopAlpha(), t["background"]!);
      expect(ratio, `noop status (${name}) = ${ratio.toFixed(2)} at opacity ${noopAlpha()}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("control: at the old 50% the same measure is below 4.5:1 in both themes (the instrument sees the failure)", () => {
    for (const theme of [":root", ".dark"] as const) {
      const t = tokens(theme);
      expect(contrastAt(t["on-surface-variant"]!, 0.5, t["background"]!)).toBeLessThan(3);
    }
  });
});
