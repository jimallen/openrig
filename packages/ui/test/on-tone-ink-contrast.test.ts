// workspaces-o9o.117: text ON a solid success or destructive (tertiary) fill clears WCAG AA (4.5:1) in both themes, as o9o.115
// did for amber. Measured before: white on success 4.01:1 (light) and 2.23:1 (dark); white on tertiary 6.59:1 (light) but
// 3.28:1 (dark); the badges that inherited the surface text were 3.19:1 (light) and 1.80:1 (dark) on success.
// There is no info fill: the "info" tone is bg-secondary and is only ever a dot.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { contrast, tokens, WHITE } from "./helpers/token-contrast.js";

const UI = path.resolve(__dirname, "..");
const THEMES = [[":root", "light"], [".dark", "dark"]] as const;

describe("the on-tone inks clear 4.5:1 on their fills in both themes (o9o.117)", () => {
  for (const [theme, name] of THEMES) {
    for (const [ink, fill] of [["on-success", "success"], ["on-tertiary", "tertiary"], ["destructive-foreground", "tertiary"]] as const) {
      it(`${name}: --${ink} on the --${fill} fill`, () => {
        const t = tokens(theme);
        expect(t[ink], `--${ink} is declared in ${theme}`).toBeDefined();
        expect(t[fill], `--${fill} is declared in ${theme}`).toBeDefined();
        const ratio = contrast(t[ink]!, t[fill]!);
        expect(ratio, `--${ink} on --${fill} (${theme}) = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("control: white is below 4.5:1 on the success fill in both themes and on the dark tertiary fill (why the inks exist)", () => {
    expect(contrast(WHITE, tokens(":root")["success"]!)).toBeLessThan(4.5);
    expect(contrast(WHITE, tokens(".dark")["success"]!)).toBeLessThan(4.5);
    expect(contrast(WHITE, tokens(".dark")["tertiary"]!)).toBeLessThan(4.5);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

describe("no solid success or destructive fill carries white text (o9o.117)", () => {
  const files = sourceFiles(path.join(UI, "src"));
  // A solid fill, with or without a variant prefix (hover:); a /NN opacity is not solid (its text is judged on the surface).
  const SOLID_FILL = /(?<![\w-])(?:[a-z-]+:)*bg-(?:success|tertiary|destructive)(?![\w/-])/;
  const WHITE_TEXT = /(?<![\w-])(?:[a-z-]+:)*text-white(?![\w-])/;

  it("no line puts white text on a solid success, tertiary or destructive fill", () => {
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8").split("\n").flatMap((line, i) => (SOLID_FILL.test(line) && WHITE_TEXT.test(line) ? [`${path.relative(UI, f)}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it("control: the scan sees solid fills of these tones, and the on-tone inks where text sits on them", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => SOLID_FILL.test(l))).length).toBeGreaterThan(10);
    expect(files.some((f) => readFileSync(f, "utf8").includes("text-on-success"))).toBe(true);
    expect(files.some((f) => readFileSync(f, "utf8").includes("text-on-tertiary"))).toBe(true);
  });
});
