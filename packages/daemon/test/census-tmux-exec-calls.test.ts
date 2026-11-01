import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTree } from "./helpers/tmux-exec-scanner.js";

// hc cutover (QA N2): a live ratchet on rule 3, "an exec-family call whose first argument is tmux". The census guard's zero
// test is skipped while the tmux adapter file still exists, so until the adapter goes nothing stopped a new `spawn("tmux")`.
// This one runs now. The adapter's own commands are argv arrays and command strings (rules 1 and 2), not exec calls: they
// are the one place tmux still lives, behind an exec an injected suite supplies (startup.ts: no runtime path passes one).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tree = scanTree(REPO_ROOT);

describe("rule 3 over packages/*/src: no exec call names tmux", () => {
  it("positive control: the scan walked the tree and still sees the tmux adapter's own commands", () => {
    expect(tree.files).toBeGreaterThan(100);
    const adapterFindings = tree.findings.filter((f) => f.file === "packages/daemon/src/adapters/tmux.ts");
    expect(adapterFindings.length).toBeGreaterThan(0);
    expect(adapterFindings.some((f) => f.rule === "argv-array" || f.rule === "command-string")).toBe(true);
  });

  it("no non-test source file calls an exec with tmux as the program", () => {
    expect(tree.findings.filter((f) => f.rule === "exec-call").map((f) => `${f.file}:${f.line} ${f.text}`)).toEqual([]);
  });
});
