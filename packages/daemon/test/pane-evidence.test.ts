// workspaces-o9o.3 review (verify-sec, attempt 2): attention evidence is stored (restore.completed), redacted downstream, and
// must be read with soft wraps joined, or a token tmux wrapped across two rows is stored as two fragments the redactor
// misses. lifecycle-scenario-matrix.test.ts drives the Claude and Codex resume adapters end to end; this file pins the
// helper and, as a census, every evidence site in src.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { joinedPaneEvidence } from "../src/domain/pane-evidence.js";

const SRC = path.resolve(import.meta.dirname, "../src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

describe("pane evidence is read with soft wraps joined (workspaces-o9o.3)", () => {
  it("asks for joined lines and keeps the last 12", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const capturePaneContent = vi.fn(async () => lines.join("\n"));
    expect(await joinedPaneEvidence({ capturePaneContent }, "s@r")).toBe(lines.slice(-12).join("\n"));
    expect(capturePaneContent).toHaveBeenCalledWith("s@r", 40, { joinWrappedLines: true });
  });

  it("an empty capture is empty evidence", async () => {
    expect(await joinedPaneEvidence({ capturePaneContent: async () => null }, "s@r")).toBe("");
  });

  // Census, by a positional predicate over every .ts file in src: a 12-line pane tail is built only by the helper, and by
  // the Pi launch site, whose content is already a joined capture (PiRuntimeAdapter.joinedPane). Positive control: the
  // helper's call sites are counted, so a census that read no files cannot pass.
  it("every evidence site in src reads through the helper", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const tails = files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n")
      .map((line, i) => ({ at: `${path.relative(SRC, f)}:${i + 1}`, line }))
      .filter(({ line }) => /\.slice\(-12\)/.test(line)));
    expect(tails.map((t) => t.at.replace(/:\d+$/, ""))).toEqual(["adapters/pi-runtime-adapter.ts"]);
    expect(tails[0]!.line).toContain("redactPaneText(paneContent.split");
    const pi = fs.readFileSync(path.join(SRC, "adapters/pi-runtime-adapter.ts"), "utf8");
    expect(pi).toMatch(/const paneContent = await this\.joinedPane\(sessionName\);\n[\s\S]{0,800}evidence: redactPaneText\(paneContent\.split/);
    const calls = files.flatMap((f) => (fs.readFileSync(f, "utf8").match(/\bjoinedPaneEvidence\(/g) ?? []).map(() => path.relative(SRC, f)));
    expect(calls.filter((f) => f !== "domain/pane-evidence.ts").sort()).toEqual([
      "adapters/claude-code-adapter.ts", "adapters/claude-code-adapter.ts",
      // the fourth: an unreadable process table retains the launch with evidence (workspaces-o9o.72)
      "adapters/claude-resume.ts", "adapters/claude-resume.ts", "adapters/claude-resume.ts", "adapters/claude-resume.ts",
      "adapters/codex-resume.ts", "adapters/codex-resume.ts",
      "adapters/codex-runtime-adapter.ts", "adapters/codex-runtime-adapter.ts", "adapters/codex-runtime-adapter.ts",
      "adapters/pda-runtime-adapter.ts",
      "adapters/pi-resume.ts",
      // a stub runner that exits before ready (workspaces-o9o.29)
      "adapters/stub-runtime-adapter.ts",
      "domain/resume-settle.ts",
    ]);
  });
});
