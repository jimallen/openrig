// The never-skip guard's decision (test/never-skip-reporter.ts), on hand-built tasks shaped like vitest's reported ones, and the
// shape of the real allow-list. The run-level effect (exit code 1, one line per finding) was checked with a scratch file when the
// guard was added; these rows pin the rule itself.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW_KINDS, findingsFor, loadAllowlist, type ReportedTest } from "../../../test/never-skip-reporter.js";

type Mode = "run" | "skip" | "todo";
interface FakeSuite { type: "suite"; name: string; parent: FakeSuite | FakeModule; options: { mode: Mode } }
interface FakeModule { type: "module" }
const MODULE: FakeModule = { type: "module" };

function suite(name: string, mode: Mode = "run", parent: FakeSuite | FakeModule = MODULE): FakeSuite {
  return { type: "suite", name, parent, options: { mode } };
}
function test(name: string, parent: FakeSuite | FakeModule, opts: { mode?: Mode; state?: "passed" | "skipped"; fails?: boolean } = {}): ReportedTest {
  const mode = opts.mode ?? "run";
  const state = opts.state ?? (mode === "run" ? "passed" : "skipped");
  return { type: "test", name, parent, options: { mode, fails: opts.fails }, result: () => ({ state }) };
}

const RESIZE = "packages/daemon/test/runner-pane-resize.real.test.ts";
const ALLOW = loadAllowlist();

describe("never-skip guard: what a finding is", () => {
  it("a skip whose describe.skipIf is listed and itself skipped is covered", () => {
    const d = suite("60 あ in the input line across resizes to odd widths, through a private hc core (OF-218, wide characters)", "skip");
    expect(findingsFor(test("typed at 200x40, resized to 31x20: one rule, one input row, nothing stale above them", d, { mode: "skip" }), RESIZE, ALLOW)).toEqual([]);
  });

  it("an unlisted skip in runner-pane-resize.real.test.ts is flagged: a new it.skip at the top level, and one under a listed describe that ran", () => {
    expect(findingsFor(test("a new row someone skipped", MODULE, { mode: "skip" }), RESIZE, ALLOW)).toEqual([
      `${RESIZE} > a new row someone skipped: skipped, and no allow-list entry covers it (test/never-skip-allowlist.json)`,
    ]);
    const ran = suite("a Pi seat's pane console across resizes, through a private hc core", "run");
    expect(findingsFor(test("a new row under a describe that ran", ran, { mode: "skip" }), RESIZE, ALLOW)).toHaveLength(1);
    // A title the file does not build is not covered either: the file's entries are its exact titles, not a pattern.
    expect(findingsFor(test("x", suite("any other title", "skip"), { mode: "skip" }), RESIZE, ALLOW)).toHaveLength(1);
  });

  it("a todo and an it.fails are findings whatever the list says", () => {
    expect(findingsFor(test("later", MODULE, { mode: "todo" }), RESIZE, ALLOW)[0]).toMatch(/todo; write the test or delete it/);
    expect(findingsFor(test("expected red", MODULE, { fails: true }), RESIZE, ALLOW)[0]).toMatch(/it\.fails/);
  });

  it("a runtime skip (ctx.skip) is covered only by an entry for that test", () => {
    const file = "packages/cli/test/mcp-daemon-endpoint-native.test.ts";
    expect(findingsFor(test("keeps the reached IPv6 daemon endpoint for MCP tool requests", MODULE, { state: "skipped" }), file, ALLOW)).toEqual([]);
    expect(findingsFor(test("another row", MODULE, { state: "skipped" }), file, ALLOW)).toHaveLength(1);
  });
});

describe("never-skip allow-list: shape", () => {
  it("every entry has a kind that says how to read `when`, and no pattern covers a whole file", () => {
    for (const e of ALLOW) {
      expect(ALLOW_KINDS, JSON.stringify(e)).toContain(e.kind);
      if (e.taskPattern !== undefined) expect(new RegExp(`^(?:${e.taskPattern})$`).test("an unrelated title"), JSON.stringify(e)).toBe(false);
    }
  });

  it("loadAllowlist refuses an entry without a kind", () => {
    const bad = [{ file: "f", task: "t", when: "w" }];
    const dir = mkdtempSync(join(tmpdir(), "never-skip-bad-"));
    writeFileSync(join(dir, "allow.json"), JSON.stringify(bad));
    try { expect(() => loadAllowlist(join(dir, "allow.json"))).toThrow(/kind/); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
