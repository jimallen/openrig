// OF-63: `rig up` preflight must refuse a seat whose resolved cwd is missing or not a directory.
// tmux does not refuse a missing `-c` directory, it starts the session in $HOME, so without this
// refusal a seat runs in the wrong place and nothing says so. Preflight never creates the directory.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import { getSeatCwdPresenceError } from "../src/domain/cwd-resolution.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RigSpec as PodRigSpec } from "../src/domain/types.js";

const RIG_ROOT = "/project/rigs/seat-cwd";

function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
}

const AGENT_FILES: Record<string, string> = {
  [`${RIG_ROOT}/agents/impl/agent.yaml`]: `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`,
};

function rigYaml(members: Array<{ id: string; agentRef: string; runtime: string; cwd: string; profile?: string }>): string {
  const spec: PodRigSpec = {
    version: "0.2", name: "seat-cwd-rig",
    pods: [{ id: "dev", label: "Dev", members: members.map((m) => ({ ...m, profile: m.profile ?? "default" })), edges: [] }],
    edges: [],
  };
  return RigSpecCodec.serialize(spec);
}

const agentSeat = (cwd: string) => ({ id: "impl", agentRef: "local:agents/impl", runtime: "claude-code", cwd });
const terminalSeat = (cwd: string) => ({ id: "human", agentRef: "builtin:terminal", runtime: "terminal", profile: "none", cwd });

describe("rig up preflight: seat cwd must be an existing directory (OF-63)", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "of63-seat-cwd-"))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const run = (yaml: string, extra: Record<string, unknown> = {}) =>
    rigPreflight({ rigSpecYaml: yaml, rigRoot: RIG_ROOT, fsOps: mockFs(AGENT_FILES) as never, ...extra });

  it("control: an existing directory passes", async () => {
    const result = await run(rigYaml([agentSeat(tmp)]));
    expect(result.errors).toEqual([]);
    expect(result.ready).toBe(true);
  });

  it("refuses an agent seat whose cwd does not exist, naming the seat and the path", async () => {
    const missing = nodePath.join(tmp, "advisor-lead");
    const result = await run(rigYaml([agentSeat(missing)]));
    expect(result.ready).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("dev.impl");
    expect(result.errors[0]).toContain(missing);
    expect(result.errors[0]).toContain("does not exist");
  });

  it("refuses a terminal seat whose cwd does not exist (the terminal branch is a separate site)", async () => {
    const missing = nodePath.join(tmp, "operator-human");
    const result = await run(rigYaml([terminalSeat(missing)]));
    expect(result.ready).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("dev.human");
    expect(result.errors[0]).toContain(missing);
  });

  it("refuses a seat whose cwd is a file, as 'not a directory' (agent and terminal sites)", async () => {
    const file = nodePath.join(tmp, "plain-file");
    fs.writeFileSync(file, "x");
    const result = await run(rigYaml([agentSeat(file), terminalSeat(file)]));
    expect(result.ready).toBe(false);
    expect(result.errors).toHaveLength(2);
    for (const e of result.errors) {
      expect(e).toContain(file);
      expect(e).toContain("not a directory");
    }
  });

  it("refuses a dangling symlink as missing, and accepts a symlink to a directory", async () => {
    const dangling = nodePath.join(tmp, "dangling");
    fs.symlinkSync(nodePath.join(tmp, "nowhere"), dangling);
    const good = nodePath.join(tmp, "good-link");
    fs.symlinkSync(tmp, good);
    expect((await run(rigYaml([agentSeat(dangling)]))).errors[0]).toContain("does not exist");
    expect((await run(rigYaml([agentSeat(good)]))).ready).toBe(true);
  });

  it("judges the --cwd override the seat actually launches in, not the authored cwd", async () => {
    const missingOverride = nodePath.join(tmp, "override-missing");
    const refused = await run(rigYaml([agentSeat(tmp)]), { cwdOverride: missingOverride });
    expect(refused.ready).toBe(false);
    expect(refused.errors[0]).toContain(missingOverride);
    // an authored cwd that is missing no longer matters once the override is an existing directory
    const accepted = await run(rigYaml([agentSeat(nodePath.join(tmp, "authored-missing"))]), { cwdOverride: tmp });
    expect(accepted.errors).toEqual([]);
  });

  it("reports every bad seat, one error each", async () => {
    const result = await run(rigYaml([
      agentSeat(nodePath.join(tmp, "a")),
      { ...agentSeat(nodePath.join(tmp, "b")), id: "second" },
    ]));
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("dev.impl");
    expect(result.errors[1]).toContain("dev.second");
  });

  it("names a cwd it cannot stat as 'not accessible' (with the errno), not as missing and not as fine", () => {
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const refusal = getSeatCwdPresenceError("/some/seat", () => { throw denied; });
    expect(refusal).toContain("/some/seat");
    expect(refusal).toContain("not accessible");
    expect(refusal).toContain("EACCES");
    expect(refusal).not.toContain("does not exist");
  });

  it.skipIf(process.getuid?.() === 0)("refuses, as 'not accessible', a seat folder under a directory the daemon cannot search", async () => {
    const parent = nodePath.join(tmp, "locked");
    const seatDir = nodePath.join(parent, "seat");
    fs.mkdirSync(seatDir, { recursive: true });
    fs.chmodSync(parent, 0o000);
    try {
      const result = await run(rigYaml([agentSeat(seatDir)]));
      expect(result.ready).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("dev.impl");
      expect(result.errors[0]).toContain(seatDir);
      expect(result.errors[0]).toContain("not accessible");
    } finally {
      fs.chmodSync(parent, 0o755);
    }
  });

  it("never creates the missing directory", async () => {
    const missing = nodePath.join(tmp, "must-stay-missing");
    await run(rigYaml([agentSeat(missing), terminalSeat(missing)]));
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("exempts only the directories the launch itself creates (project rig plan)", async () => {
    const created = nodePath.join(tmp, ".workspaces", "dev-impl");
    const other = nodePath.join(tmp, ".workspaces", "dev-other");
    const yaml = rigYaml([agentSeat(created), { ...agentSeat(other), id: "other" }]);
    const result = await run(yaml, { cwdsCreatedByLaunch: [created] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("dev.other");
    expect(result.errors[0]).toContain(other);
  });
});
