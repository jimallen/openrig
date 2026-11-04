// FORK-OWNED (jimallen/openrig; not in upstream mvschwarz/openrig). OF-223, Jim's decision "enforce + ratchet": the domain
// (src/domain) depends on no adapter, no src/db and no infrastructure module. Today's violations are recorded in
// local/architecture/hexagonal-baseline.txt; this file fails on any violation not recorded there, and on any recorded one that
// is gone, so the baseline only shrinks. The rule, the type-only decision and the upstream-merge procedure are in
// local/architecture/hexagonal-boundary.md.
//
// Census (instrument: the TypeScript parser over every *.ts under packages/daemon/src/domain; helpers/fork-hexagonal-boundary.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BASELINE_PATH, RULE_DOC, SYNC_COMMAND, attributeToUpstream, classifyEdge, compareToBaseline, describeComparison, formatBaseline,
  parseBaseline, scanDomain, scanImports, violationKey, violationsInSource, type BaselineEntry, type Violation,
} from "./helpers/fork-hexagonal-boundary.js";

const scan = scanDomain();
const baseline = parseBaseline(readFileSync(BASELINE_PATH, "utf8"));

describe("hexagonal boundary census: the scan", () => {
  it("positive control: the scan saw the whole domain tree, nested folders included", () => {
    console.log(`[OF-223] scanned ${scan.files.length} domain files; ${scan.violations.length} violations (${scan.statements} import statements); baseline ${baseline.length} lines (${baseline.filter((e) => e.origin === "upstream").length} upstream, ${baseline.filter((e) => e.origin === "fork").length} fork)`);
    expect(scan.files.length).toBeGreaterThan(500);
    expect(scan.files).toContain("src/domain/event-bus.ts");
    expect(scan.files.some((f) => f.startsWith("src/domain/gateway/"))).toBe(true);
    expect(scan.files.every((f) => f.startsWith("src/domain/") && f.endsWith(".ts"))).toBe(true);
    // The scan reads the files it lists: a known violation is found where it is.
    expect(scan.violations.map(violationKey)).toContain("src/domain/event-bus.ts better-sqlite3 type");
  });

  it("every import whose module cannot be read statically is a known one (a new one would be invisible to this census)", () => {
    expect(scan.unresolved.map((u) => `${u.file} ${u.form}`)).toEqual(["src/domain/skill-mirror-drift.ts dynamic-import"]);
  });
});

describe("hexagonal boundary census: the ratchet against the baseline", () => {
  it("has no violation the baseline does not record, no stale line and no line to tighten", () => {
    const comparison = compareToBaseline(scan.violations, baseline);
    expect(describeComparison(comparison)).toBe("");
  });

  it("every baseline line names a domain file and a target the rule forbids", () => {
    for (const e of baseline) {
      expect(e.file.startsWith("src/domain/"), e.file).toBe(true);
      expect(classifyEdge(e.file, e.target.startsWith("src/") ? relativeFrom(e.file, e.target) : e.target), `${e.file} ${e.target}`).not.toBeNull();
    }
  });
});

describe("the parser: every import form, and nothing that only mentions a module", () => {
  const edges = (source: string) => scanImports("src/domain/x.ts", source).edges.map((e) => `${e.form} ${e.kind} ${e.specifier}`);

  it("reads static, side-effect, type-only, inline-type, export-from, import-equals, dynamic, require and type-position imports", () => {
    const source = [
      `import { a } from "../adapters/a.js";`,
      `import "../adapters/side.js";`,
      `import type { T } from "../adapters/t.js";`,
      `import { type U, type V } from "../adapters/uv.js";`,
      `import { type W, x } from "../adapters/wx.js";`,
      `import Default, { type Y } from "../adapters/dy.js";`,
      `import * as ns from "node:os";`,
      `export { e } from "../adapters/e.js";`,
      `export type { F } from "../adapters/f.js";`,
      `export { type G } from "../adapters/g.js";`,
      `export * from "../adapters/star.js";`,
      `import cp = require("child_process");`,
      `const lazy = await import("node:net");`,
      `const fs = require("fs");`,
      `let d: import("better-sqlite3").Database;`,
      `import {`,
      `  one,`,
      `  type two,`,
      `} from "../adapters/multi.js";`,
    ].join("\n");
    expect(edges(source)).toEqual([
      "import value ../adapters/a.js",
      "import value ../adapters/side.js",
      "import-type type ../adapters/t.js",
      "import-type type ../adapters/uv.js",
      "import value ../adapters/wx.js",
      "import value ../adapters/dy.js",
      "import value node:os",
      "export-from value ../adapters/e.js",
      "export-from type ../adapters/f.js",
      "export-from type ../adapters/g.js",
      "export-from value ../adapters/star.js",
      "import-equals value child_process",
      "dynamic-import value node:net",
      "require value fs",
      "type-position-import type better-sqlite3",
      "import value ../adapters/multi.js",
    ]);
    // The multi-line import is reported at the line it starts on.
    expect(scanImports("src/domain/x.ts", source).edges.at(-1)?.line).toBe(16);
  });

  it("does not count a module named in a string, a template, a comment or a JSDoc type", () => {
    const source = [
      `// import { a } from "../adapters/a.js";`,
      `/* import "node:child_process"; require("node:fs") */`,
      `/** @type {import("better-sqlite3").Database} */`,
      `const s = "import x from '../adapters/tmux.js'";`,
      "const t = `require(\"node:fs\"); import(\"node:net\")`;",
      `const u = ["node:child_process", "../db/connection.js"];`,
      `const worker = String.raw\`const fs = require("node:fs");\`;`,
    ].join("\n");
    expect(scanImports("src/domain/x.ts", source)).toEqual({ edges: [], unresolved: [] });
  });

  it("reports a dynamic import or require it cannot resolve, instead of dropping it", () => {
    const result = scanImports("src/domain/x.ts", `const m = await import(path);\nconst n = require(name);`);
    expect(result.edges).toEqual([]);
    expect(result.unresolved.map((u) => `${u.form}@${u.line}`)).toEqual(["dynamic-import@1", "require@2"]);
  });
});

describe("the rule: which targets a domain file may not import", () => {
  it("forbids adapters, src/db and the infrastructure modules, by position; allows the rest", () => {
    expect(classifyEdge("src/domain/a.ts", "../adapters/tmux.js")).toEqual({ target: "src/adapters/tmux.js", rule: "domain-imports-adapter" });
    expect(classifyEdge("src/domain/gateway/b.ts", "../../adapters/hc-client.js")).toEqual({ target: "src/adapters/hc-client.js", rule: "domain-imports-adapter" });
    expect(classifyEdge("src/domain/a.ts", "../db/connection.js")).toEqual({ target: "src/db/connection.js", rule: "domain-imports-db" });
    expect(classifyEdge("src/domain/a.ts", "../db/migrations/001_x.js")?.rule).toBe("domain-imports-db");
    for (const spec of ["better-sqlite3", "fs", "node:fs", "fs/promises", "node:fs/promises", "child_process", "node:child_process", "net", "node:net", "http", "node:http", "os", "node:os"]) {
      expect(classifyEdge("src/domain/a.ts", spec)?.rule, spec).toBe("domain-imports-infrastructure");
    }
    expect(classifyEdge("src/domain/a.ts", "fs")?.target).toBe("node:fs");
    for (const spec of ["./types.js", "../lib/pane-envelope.js", "node:path", "node:crypto", "yaml", "ulid", "../adapters-like/x.js"]) {
      expect(classifyEdge("src/domain/a.ts", spec), spec).toBeNull();
    }
  });

  it("collapses statements of one target and kind in one file into one violation, keeping value and type apart", () => {
    const { violations } = violationsInSource("src/domain/a.ts", [
      `import { a } from "../adapters/tmux.js";`,
      `import { b } from "../adapters/tmux.js";`,
      `import type { C } from "../adapters/tmux.js";`,
    ].join("\n"));
    expect(violations.map((v) => `${violationKey(v)} @${v.lines.join(",")}`)).toEqual([
      "src/domain/a.ts src/adapters/tmux.js value @1,2",
      "src/domain/a.ts src/adapters/tmux.js type @3",
    ]);
  });
});

describe("the comparison and its messages", () => {
  const v = (file: string, target: string, kind: "value" | "type"): Violation => ({ file, target, kind, rule: target.startsWith("src/adapters/") ? "domain-imports-adapter" : "domain-imports-infrastructure", lines: [7], forms: ["import"] });
  const e = (file: string, target: string, kind: "value" | "type", origin: "upstream" | "fork", lineNo: number): BaselineEntry => ({ file, target, kind, origin, lineNo });

  it("a new violation fails, naming the file, the import and the rule, and says how to fix it", () => {
    const c = compareToBaseline([v("src/domain/a.ts", "node:child_process", "value")], []);
    const message = describeComparison(c);
    expect(c.added).toHaveLength(1);
    expect(message).toContain("packages/daemon/src/domain/a.ts:7 imports node:child_process (value; import)");
    expect(message).toContain("the domain imports an infrastructure module");
    expect(message).toContain("declare what the domain needs as a port");
    expect(message).toContain("implement it in\n  src/adapters");
    expect(message).toContain(SYNC_COMMAND);
    expect(message).toContain(RULE_DOC);
  });

  it("a type-only violation is a violation of its own: a recorded type line does not cover a new value import", () => {
    const c = compareToBaseline([v("src/domain/a.ts", "src/adapters/tmux.js", "value")], [e("src/domain/a.ts", "src/adapters/tmux.js", "type", "upstream", 5)]);
    expect(c.added.map(violationKey)).toEqual(["src/domain/a.ts src/adapters/tmux.js value"]);
    expect(c.stale.map(violationKey)).toEqual(["src/domain/a.ts src/adapters/tmux.js type"]);
  });

  it("a stale line fails and says to delete it, naming its line; an upstream one says upstream removed it", () => {
    const c = compareToBaseline([], [e("src/domain/a.ts", "node:os", "value", "fork", 9), e("src/domain/b.ts", "node:os", "value", "upstream", 10)]);
    const message = describeComparison(c);
    expect(message).toContain("2 STALE baseline line(s)");
    expect(message).toContain("delete the line");
    expect(message).toContain("line 9: src/domain/a.ts node:os value fork\n");
    expect(message).toContain("line 10: src/domain/b.ts node:os value upstream (upstream removed it)");
  });

  it("a value line whose import became type-only must be tightened, not left", () => {
    const c = compareToBaseline([v("src/domain/a.ts", "src/adapters/tmux.js", "type")], [e("src/domain/a.ts", "src/adapters/tmux.js", "value", "upstream", 5)]);
    expect(c.tightened).toHaveLength(1);
    expect(c.added).toHaveLength(1);
    expect(describeComparison(c)).toContain('change "value" to "type"');
  });

  it("a value line whose import became type-only, in a file whose type line is recorded already, is stale (no duplicate line)", () => {
    const c = compareToBaseline([v("src/domain/a.ts", "src/adapters/tmux.js", "type")], [
      e("src/domain/a.ts", "src/adapters/tmux.js", "type", "upstream", 5),
      e("src/domain/a.ts", "src/adapters/tmux.js", "value", "upstream", 6),
    ]);
    expect(c.tightened).toEqual([]);
    expect(c.added).toEqual([]);
    expect(c.stale.map((x) => x.lineNo)).toEqual([6]);
  });

  it("the baseline format round-trips, and a malformed, duplicate or unsorted line is refused with its line number", () => {
    const entries = [e("src/domain/b.ts", "node:os", "value", "fork", 0), e("src/domain/a.ts", "node:fs", "type", "upstream", 0)];
    const parsed = parseBaseline(formatBaseline(entries));
    expect(parsed.map((p) => `${violationKey(p)} ${p.origin}`)).toEqual(["src/domain/a.ts node:fs type upstream", "src/domain/b.ts node:os value fork"]);
    expect(() => parseBaseline("src/domain/a.ts node:fs maybe fork\n")).toThrow(/:1: malformed line/);
    expect(() => parseBaseline("src/domain/b.ts node:os value fork\nsrc/domain/a.ts node:os value fork\n")).toThrow(/:2: out of order or duplicate/);
    expect(() => parseBaseline("src/domain/a.ts node:os value fork\nsrc/domain/a.ts node:os value upstream\n")).toThrow(/:2: out of order or duplicate/);
  });
});

describe("attribution of a new violation to upstream or the fork (the merge procedure)", () => {
  const added = [
    { file: "src/domain/up.ts", target: "src/adapters/tmux.js", kind: "value" as const, rule: "domain-imports-adapter" as const, lines: [1], forms: ["import" as const] },
    { file: "src/domain/forkonly.ts", target: "node:os", kind: "value" as const, rule: "domain-imports-infrastructure" as const, lines: [1], forms: ["import" as const] },
    { file: "src/domain/stronger.ts", target: "src/adapters/tmux.js", kind: "value" as const, rule: "domain-imports-adapter" as const, lines: [1], forms: ["import" as const] },
    { file: "src/domain/gone-upstream.ts", target: "node:child_process", kind: "value" as const, rule: "domain-imports-infrastructure" as const, lines: [1], forms: ["import" as const] },
  ];
  const upstreamRef: Record<string, string> = {
    "src/domain/up.ts": `import { x } from "../adapters/tmux.js";`,
    "src/domain/stronger.ts": `import type { X } from "../adapters/tmux.js";`,
    "src/domain/gone-upstream.ts": `export const clean = 1;`,
  };
  const mergeBase: Record<string, string> = { "src/domain/gone-upstream.ts": `import { execFileSync } from "node:child_process";` };
  const copiesFrom = (tree: Record<string, string>) => (f: string) => (tree[f] === undefined ? [] : [{ path: f, text: tree[f] }]);

  it("upstream owns it when an upstream copy of the file has the same target at the same or a stronger kind; otherwise the fork does", () => {
    const { upstream, fork } = attributeToUpstream(added, copiesFrom(upstreamRef), copiesFrom(mergeBase));
    expect(upstream.map((x) => x.file)).toEqual(["src/domain/up.ts", "src/domain/gone-upstream.ts"]);
    // fork-only path; and a value import where upstream has only a type import (the fork strengthened it).
    expect(fork.map((x) => x.file)).toEqual(["src/domain/forkonly.ts", "src/domain/stronger.ts"]);
  });

  it("an upstream copy at another path (a rename) resolves its relative imports from its own path", () => {
    const renamed = { file: "src/domain/moved/session.ts", target: "src/adapters/shell-quote.js", kind: "value" as const, rule: "domain-imports-adapter" as const, lines: [1], forms: ["import" as const] };
    const atOldPath = () => [{ path: "src/domain/claims.ts", text: `import { shellQuote } from "../adapters/shell-quote.js";` }];
    expect(attributeToUpstream([renamed], atOldPath).upstream).toHaveLength(1);
    // Read as if it were at the fork's path, "../adapters" would be src/domain/adapters, and the line would be the fork's.
    const atForkPath = () => [{ path: renamed.file, text: `import { shellQuote } from "../adapters/shell-quote.js";` }];
    expect(attributeToUpstream([renamed], atForkPath).fork).toHaveLength(1);
  });

  it("without the merge base, a violation upstream has since removed would be charged to the fork", () => {
    const { fork } = attributeToUpstream(added, copiesFrom(upstreamRef));
    expect(fork.map((x) => x.file)).toContain("src/domain/gone-upstream.ts");
  });
});

/** The baseline records adapter and db targets as paths under packages/daemon; classifyEdge reads a specifier. */
function relativeFrom(file: string, target: string): string {
  const up = file.split("/").length - 2;
  return `${"../".repeat(up)}${target.slice("src/".length)}`;
}
