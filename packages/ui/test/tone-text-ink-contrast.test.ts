// workspaces-o9o.120: every tone used as TEXT is readable on every surface of both themes (Jim's o9o.113 rule: text gets its own
// ink, fills keep the brand colour). Measured from the tokens: only green failed (--success as text: 3.03:1 on light
// surface-container-highest, 3.78:1 on the light page, 3.78:1 rendered in the twin's install plan), so green text uses
// --success-ink. Tertiary (= destructive), secondary and primary already clear 4.5:1 everywhere as text; they are pinned here
// so a token change cannot break them unnoticed. Amber's ink is pinned in warning-ink-contrast.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { contrast, tokens } from "./helpers/token-contrast.js";

const UI = path.resolve(__dirname, "..");
const SURFACES = ["background", "surface-container-lowest", "surface-container-low", "surface-container",
  "surface-container-high", "surface-container-highest"];
const THEMES = [[":root", "light"], [".dark", "dark"]] as const;

describe("tone text clears 4.5:1 on every surface of both themes (o9o.120)", () => {
  for (const [theme, name] of THEMES) {
    for (const ink of ["success-ink", "tertiary", "secondary", "primary"]) {
      it(`${name}: --${ink} as text on each surface`, () => {
        const t = tokens(theme);
        expect(t[ink], `--${ink} is declared in ${theme}`).toBeDefined();
        for (const surface of SURFACES) {
          expect(t[surface], `--${surface} is declared in ${theme}`).toBeDefined();
          const ratio = contrast(t[ink]!, t[surface]!);
          expect(ratio, `--${ink} on --${surface} (${name}) = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it("control: the brand green itself is below 4.5:1 as light text, which is why green text has its own ink", () => {
    const t = tokens(":root");
    expect(contrast(t["success"]!, t["surface-container-highest"]!)).toBeLessThan(4.5);
    expect(contrast(t["success"]!, t["background"]!)).toBeLessThan(4.5);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

describe("no green text class except the ink (o9o.120)", () => {
  // `text-success` with nothing after it, with or without a variant prefix (hover:); `text-success-ink` is the ink.
  const BARE = /(?<![\w-])(?:[a-z-]+:)*text-success(?![\w/-])/;
  const files = sourceFiles(path.join(UI, "src"));

  it("no source file uses the brand green as a text colour", () => {
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8").split("\n").flatMap((line, i) => (BARE.test(line) && !/^\s*(\*|\/\/)/.test(line) ? [`${path.relative(UI, f)}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it("control: the scan sees the source tree, and the ink where green text is used", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => readFileSync(f, "utf8").includes("text-success-ink")).length).toBeGreaterThan(10);
  });
});
