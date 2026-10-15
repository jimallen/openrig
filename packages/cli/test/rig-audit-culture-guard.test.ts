// `rig spec audit` reads the rig's culture file through the daemon's culture-file guard (via the
// @openrig/daemon/culture-file surface). Before this it used a plain readFileSync, so a FIFO hung the
// command. These rows drive the REAL default deps (rigCommand() with no override), so they exercise the
// production wiring; the audit does not touch the daemon.
//
// FIFO row: a writer stays attached (looping) and is killed in `finally`, so a regression that reads the
// FIFO FAILS (no culture_unreadable finding) instead of hanging the worker.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Command } from "commander";
import { rigCommand } from "../src/commands/rig.js";

const MARKER = "AUDIT-CULTURE-MARKER";

describe("rig spec audit: the culture file is read through the culture-file guard", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rig-audit-culture-"));
    fs.writeFileSync(path.join(dir, "rig.yaml"), [
      'version: "0.2"', "name: audit-rig", "culture_file: CULTURE.md", "startup:", "  files: [{ path: a.md }]", "pods:",
      "  - id: dev", "    members:", "      - id: impl", "        runtime: claude-code",
    ].join("\n"));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  async function audit(): Promise<{ findings: Array<{ kind: string; message: string }> }> {
    const logs: string[] = [];
    const origLog = console.log; const origErr = console.error; const origExit = process.exitCode;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      const program = new Command(); program.exitOverride();
      program.addCommand(rigCommand());
      await program.parseAsync(["node", "rig", "spec", "audit", path.join(dir, "rig.yaml"), "--json"]);
    } finally { console.log = origLog; console.error = origErr; process.exitCode = origExit; }
    return JSON.parse(logs.join("\n"));
  }
  const kinds = (r: { findings: Array<{ kind: string }> }) => r.findings.map((f) => f.kind);

  it("CONTROL: a regular single-link culture file is read (its stale seat id is found, no unreadable finding)", async () => {
    fs.writeFileSync(path.join(dir, "CULTURE.md"), `# culture\n${MARKER} see \`dev.gone\`\n`);
    const r = await audit();
    expect(kinds(r)).toContain("stale_culture_seat_id");
    expect(kinds(r)).not.toContain("culture_unreadable");
  });

  it("a FIFO is refused as not a regular file and the audit does not hang", async () => {
    const fifo = path.join(dir, "CULTURE.md");
    execFileSync("mkfifo", [fifo]);
    const writer = spawn("sh", ["-c", 'while :; do printf "%s" "$1" > "$2"; done', "sh", `# fifo\n${MARKER} \`dev.gone\`\n`, fifo], { stdio: "ignore" });
    try {
      const r = await audit();
      const f = r.findings.find((x) => x.kind === "culture_unreadable");
      expect(f, JSON.stringify(r)).toBeDefined();
      expect(f!.message).toMatch(/is not a regular file/);
      expect(kinds(r)).not.toContain("stale_culture_seat_id");
    } finally { writer.kill("SIGKILL"); }
  }, 10000);

  it("an oversize culture file is refused, naming the limit", async () => {
    fs.writeFileSync(path.join(dir, "CULTURE.md"), Buffer.alloc(256 * 1024 + 1, 0x61));
    const f = (await audit()).findings.find((x) => x.kind === "culture_unreadable");
    expect(f?.message).toMatch(/over the 262144-byte limit/);
  });

  it("a hard-linked culture file is refused", async () => {
    fs.writeFileSync(path.join(dir, "CULTURE.md"), `# culture\n${MARKER}\n`);
    fs.linkSync(path.join(dir, "CULTURE.md"), path.join(dir, "alias.md"));
    const f = (await audit()).findings.find((x) => x.kind === "culture_unreadable");
    expect(f?.message).toMatch(/has 2 hard links/);
  });
});
