import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// workspaces-o9o.58: how the o9o.17 symlink-swap residual was accepted. Nobody chose it in the modal: the question
// to Jim went unanswered for 15 minutes and OpenRig's auto-answer took its Recommended option, "Accept the residual"
// (queue record qa-f5c084b1679e94516e44aff1e88a8361, 2026-11-16 18:21Z). Under Jim's 2026-11-08 rule that is his go,
// but the record has to say how it was taken. Every shipped text that cites the decision says so, wherever it is.

const repoRoot = resolve(import.meta.dirname, "../../..");
const RECORD = "qa-f5c084b1679e94516e44aff1e88a8361";
const TEXT = /\.(md|ts|tsx|mjs|js)$/;

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (TEXT.test(entry.name)) out.push(path);
  }
  return out;
}

/** The shipped prose: the changelog, the docs and every package's source. Tests are not shipped text. */
function shippedText(): Array<{ file: string; lines: string[] }> {
  const files = [join(repoRoot, "CHANGELOG.md"), ...walk(join(repoRoot, "docs"), [])];
  for (const pkg of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    const src = join(repoRoot, "packages", pkg.name, "src");
    if (pkg.isDirectory() && existsSync(src)) files.push(...walk(src, []));
  }
  return files.map((file) => ({ file: relative(repoRoot, file), lines: readFileSync(file, "utf-8").split("\n") }));
}

/** A line that cites the decision: it names a residual and the day it was accepted. */
const citesTheDecision = (line: string) => /residual/i.test(line) && line.includes("2026-11-16");

/** The ways the old text credited the choice to Jim himself. */
function creditsJimDirectly(text: string): boolean {
  return /accepted by Jim/i.test(text) || /\(Jim, 2026-11-16[^)]*"Accept the residual"\)/.test(text);
}

describe("o9o.58: the o9o.17 residual is recorded as taken by OpenRig's auto-answer", () => {
  it("the predicate catches both forms the old text used, and passes the new wording (controls)", () => {
    expect(creditsJimDirectly('- Residual, accepted by Jim on 2026-11-16 ("Accept the residual"): a parent')).toBe(true);
    expect(creditsJimDirectly('   * Residual, accepted (Jim, 2026-11-16: "Accept the residual"): an ancestor')).toBe(true);
    expect(creditsJimDirectly("Residual, accepted on 2026-11-16 by OpenRig's 15-minute auto-answer")).toBe(false);
  });

  it("every citation in the changelog, the docs and the source names the auto-answer and its queue record", () => {
    const corpus = shippedText();
    const residualLines = corpus.reduce((n, { lines }) => n + lines.filter((l) => /residual/i.test(l)).length, 0);
    expect(residualLines).toBeGreaterThan(30); // the population the filter ran over is the real tree

    const sites: string[] = [];
    for (const { file, lines } of corpus) {
      lines.forEach((line, i) => {
        if (!citesTheDecision(line)) return;
        sites.push(file);
        const paragraph = lines.slice(i, i + 5).join("\n");
        expect(paragraph, `${file}:${i + 1}`).toMatch(/auto-answer/);
        expect(paragraph, `${file}:${i + 1}`).toContain(RECORD);
        expect(paragraph, `${file}:${i + 1}`).toMatch(/2026-11-08/);
      });
    }
    // the three sites o9o.17 shipped (positive control); a later citation must meet the same bar, not this list
    expect([...new Set(sites)]).toEqual(expect.arrayContaining([
      "CHANGELOG.md",
      "docs/as-built/architecture/plugin-agent-image-context-pack.md",
      "packages/daemon/src/domain/plugin-vendor-service.ts",
    ]));
  });

  it("no shipped text credits the choice to Jim directly", () => {
    const offenders = shippedText().flatMap(({ file, lines }) =>
      lines.flatMap((line, i) => (creditsJimDirectly(line) ? [`${file}:${i + 1}`] : [])));
    expect(offenders).toEqual([]);
  });
});
