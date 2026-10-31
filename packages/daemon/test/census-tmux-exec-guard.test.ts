import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listSourceFiles, scanTmuxExecs, scanTree, type TmuxExecRule } from "./helpers/tmux-exec-scanner.js";

// Census guard: zero `tmux` execs in non-test source (hc cutover W8; census-hc-tmux section 4, layer 1).
//
// The zero assertion cannot hold while tmux code is still in src, so it is SKIPPED until the scan finds nothing, and then
// it runs on its own (no one has to remember to flip it). The self-tests below keep a clean zero from coming from a
// broken scanner: one fixture per rule shape, near-misses that must not match, and the current tree, which must still
// produce findings while the tmux adapter file exists. At cutover end the adapter file is gone, that control stops
// applying, the zero test runs, and the exemptions allowlist stays unbuilt (zero means zero).
//
// What a clean zero here does NOT prove: a tmux command assembled at run time, or reached only through a config string
// (`TMUX_BIN` in ~/.agents' openrig-deploy is outside this repo), is invisible to a static scan. A PATH shim that
// records real execs (census layer 2) is not built in this package. Vocabulary that only names tmux (a persisted
// `attachment_type` of "tmux", prose) is not a finding; the census tracks it by a separate vocabulary ratchet.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rulesOf = (file: string, source: string): TmuxExecRule[] => scanTmuxExecs(file, source).map((f) => f.rule);

describe("tmux exec scanner: it would catch one (self-test)", () => {
  it("rule 1: a command string that starts with tmux and an argument, as string, no-substitution template and template head", () => {
    expect(rulesOf("x.ts", `const a = "tmux -V";`)).toEqual(["command-string"]);
    expect(rulesOf("x.ts", "const a = `  tmux has-session -t x`;")).toEqual(["command-string"]);
    expect(rulesOf("x.ts", "const a = `tmux send-keys -t ${name} Enter`;")).toEqual(["command-string"]);
  });

  it("rule 2: an argv array whose first element is tmux or a path ending in /tmux", () => {
    expect(rulesOf("x.ts", `const a = ["tmux", "kill-server"];`)).toEqual(["argv-array"]);
    expect(rulesOf("x.ts", `const a = ["/opt/homebrew/bin/tmux", "ls"];`)).toEqual(["argv-array"]);
  });

  it("rule 3: an exec-family call whose first argument is tmux, bare or as a property, any listed verb", () => {
    expect(rulesOf("x.ts", `spawnSync("tmux", args);`)).toEqual(["exec-call"]);
    expect(rulesOf("x.ts", `cp.execFileSync("/usr/bin/tmux", args);`)).toEqual(["exec-call"]);
    expect(rulesOf("x.ts", `await execa("tmux");`)).toEqual(["exec-call"]);
    expect(rulesOf("x.ts", `run("tmux");`)).toEqual(["exec-call"]);
  });

  it("rule 4: static import, re-export, dynamic import of adapters/tmux*, and the TmuxAdapter name from anywhere", () => {
    expect(rulesOf("x.ts", `import { TmuxResult } from "../adapters/tmux.js";`)).toEqual(["tmux-import"]);
    expect(rulesOf("x.ts", `export * from "./adapters/tmux-lifecycle.js";`)).toEqual(["tmux-import"]);
    expect(rulesOf("x.ts", `const m = await import("../adapters/tmux.js");`)).toEqual(["tmux-import"]);
    expect(rulesOf("x.ts", `import { TmuxAdapter } from "./elsewhere.js";`)).toEqual(["tmux-import"]);
    expect(rulesOf("x.ts", `import { TmuxAdapter as T } from "./elsewhere.js";`)).toEqual(["tmux-import"]);
  });

  it("near misses are not findings: bare word, other program, other module, prose that merely contains tmux", () => {
    const source = [
      `const attachmentType = "tmux";`,
      `spawnSync("hc", ["run"]);`,
      `const msg = "start tmux first";`,
      `const a = ["hc", "tmux"];`,
      `import { HcClient } from "../adapters/hc-client.js";`,
      `import { x } from "../adapters/tmuxy-not.js/other";`,
      `exec("ssh host tmux ls");`,
      `notExec("tmux");`,
    ].join("\n");
    expect(scanTmuxExecs("x.ts", source)).toEqual([]);
  });

  it("migrations keep the word in rule 1 only: rule 1 is skipped there, rules 2 to 4 are not", () => {
    expect(rulesOf("src/db/migrations/019_x.ts", "const sql = \"UPDATE t SET a = 'tmux -V'\";\nconst s = \"tmux -V\";")).toEqual([]);
    expect(rulesOf("src/db/migrations/019_x.ts", `spawnSync("tmux");`)).toEqual(["exec-call"]);
  });

  it("reports the file, the 1-based line and the matched text", () => {
    const found = scanTmuxExecs("src/a.ts", `const x = 1;\n\nspawnSync("tmux", ["-V"]);`);
    expect(found).toEqual([{ rule: "exec-call", file: "src/a.ts", line: 3, text: `spawnSync("tmux", ["-V"])` }]);
  });

  it("test files and build output are not scanned: a scratch tree with one of each lists only the source files", () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-scan-tree-"));
    try {
      const put = (rel: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), "export {};\n"); };
      for (const rel of [
        "packages/a/src/keep.ts", "packages/a/src/deep/keep.tsx", "packages/b/src/keep.mjs",
        "packages/a/src/x.test.ts", "packages/a/src/y.spec.ts", "packages/a/src/__tests__/z.ts", "packages/a/src/test/w.ts",
        "packages/a/src/types.d.ts", "packages/a/src/node_modules/m/i.ts", "packages/a/src/dist/o.js", "packages/a/src/notes.md",
        "packages/c/lib/not-src.ts", "other/src/not-a-package.ts",
      ]) put(rel);
      expect(listSourceFiles(root)).toEqual(["packages/a/src/deep/keep.tsx", "packages/a/src/keep.ts", "packages/b/src/keep.mjs"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("the tree listing finds the real source of every package", () => {
    const files = listSourceFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.every((f) => /^packages\/[^/]+\/src\//.test(f))).toBe(true);
  });
});

const tmuxAdapterStillInSrc = existsSync(join(REPO_ROOT, "packages", "daemon", "src", "adapters", "tmux.ts"));
const tree = scanTree(REPO_ROOT);

describe("tmux exec census over packages/*/src", () => {
  // Positive control on the real tree: while the adapter exists the scan must see tmux execs. A scanner that
  // silently finds nothing would otherwise turn the zero test green the moment it runs.
  it.skipIf(!tmuxAdapterStillInSrc)("positive control: the scan finds tmux execs while the tmux adapter file still exists", () => {
    expect(tree.files).toBeGreaterThan(100);
    expect(tree.findings.length).toBeGreaterThan(0);
    expect(new Set(tree.findings.map((f) => f.rule)).has("exec-call") || new Set(tree.findings.map((f) => f.rule)).has("tmux-import")).toBe(true);
  });

  // Skipped while tmux code remains; runs, and must pass, once the scan is clean.
  it.skipIf(tree.findings.length > 0)("pins ZERO tmux execs in non-test source", () => {
    expect(tree.findings.map((f) => `${f.file}:${f.line} ${f.rule}`)).toEqual([]);
  });
});
