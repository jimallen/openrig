import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { resolveAgentRef, type AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import { agentPreflight } from "../src/domain/agent-preflight.js";
import { PERSONA_FILE_MAX_BYTES, guardedAgentRefFsOps } from "../src/domain/agent-ref-guard.js";
import { DEFAULT_PATH_JUDGE_IO, type PathJudgeIo } from "../src/domain/codex-mcp-servers.js";
import { deployedAgentsReleaseRoot } from "../src/adapters/agents-release-root.js";

// The cap is pinned as a LITERAL: a test that reads the constant from the module it tests moves with a mutant.
const CAP = 65536;

// Production wiring: the same two members every real filesystem the resolver is given carries.
const realFs: AgentResolverFsOps = {
  ...guardedAgentRefFsOps,
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  exists: (p) => fs.existsSync(p),
};

const AGENT = (name: string, imports: string[] = []) =>
  `name: ${name}\nversion: "1.0"\nresources:\n  skills: []\n  guidance: []\n  subagents: []\n  plugins: []\n  runtime_resources: []\nprofiles:\n  default:\n    uses:\n      skills: []\n      guidance: []\n      subagents: []\n      plugins: []\n      runtime_resources: []\n${imports.length ? `imports:\n${imports.map((r) => `  - ref: ${r}`).join("\n")}\n` : ""}`;

let root: string; // realpath'd temp dir (macOS /var -> /private/var)
const writers: ChildProcess[] = [];

function persona(dir: string, name: string, imports: string[] = []): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(nodePath.join(dir, "agent.yaml"), AGENT(name, imports));
  return dir;
}

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "agent-ref-guard-"))); });
afterEach(() => {
  for (const w of writers.splice(0)) { try { w.kill("SIGKILL"); } catch { /* already gone */ } }
  fs.rmSync(root, { recursive: true, force: true });
});

function refusedWith(r: ReturnType<typeof resolveAgentRef>, code: string, msg: RegExp): void {
  expect(r.ok, JSON.stringify(r)).toBe(false);
  if (r.ok) return;
  expect(r.code).toBe(code);
  expect((r as { error: string }).error).toMatch(msg);
}

describe("local: refs stay inside their spec tree", () => {
  it("POSITIVE: a ref inside the rig folder resolves", () => {
    persona(nodePath.join(root, "rig", "agents", "impl"), "impl");
    const r = resolveAgentRef("local:agents/impl", nodePath.join(root, "rig"), realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.resolved.sourcePath).toBe(nodePath.join(root, "rig", "agents", "impl"));
  });

  it("L1: local:../outside (a lexical .. out of the rig folder) is refused and says to use path:", () => {
    persona(nodePath.join(root, "outside"), "outside");
    fs.mkdirSync(nodePath.join(root, "rig"));
    const r = resolveAgentRef("local:../outside", nodePath.join(root, "rig"), realFs);
    refusedWith(r, "ref_refused", /outside .*use path:\/absolute\/dir/);
  });

  it("L2: a symlink inside the rig that resolves outside is refused after realpath", () => {
    persona(nodePath.join(root, "outside"), "outside");
    fs.mkdirSync(nodePath.join(root, "rig", "agents"), { recursive: true });
    fs.symlinkSync(nodePath.join(root, "outside"), nodePath.join(root, "rig", "agents", "impl"));
    const r = resolveAgentRef("local:agents/impl", nodePath.join(root, "rig"), realFs);
    refusedWith(r, "ref_refused", /outside .*use path:\/absolute\/dir/);
  });

  it("L5: a lexical .. out of the rig folder is refused even when a symlink there points back inside", () => {
    persona(nodePath.join(root, "rig", "agents", "impl"), "impl");
    fs.symlinkSync(nodePath.join(root, "rig", "agents", "impl"), nodePath.join(root, "back"));
    const r = resolveAgentRef("local:../back", nodePath.join(root, "rig"), realFs);
    refusedWith(r, "ref_refused", /outside/);
  });

  it("L3: a .. that escapes is refused even when the target does not exist", () => {
    fs.mkdirSync(nodePath.join(root, "rig"));
    const r = resolveAgentRef("local:../../etc", nodePath.join(root, "rig"), realFs);
    refusedWith(r, "ref_refused", /outside/);
  });

  it("POSITIVE (release/built-in layout): <tree>/rigs/<rig> naming local:../../agents/<p> resolves", () => {
    persona(nodePath.join(root, "tree", "agents", "engineer"), "engineer");
    fs.mkdirSync(nodePath.join(root, "tree", "rigs", "team"), { recursive: true });
    const ok = resolveAgentRef("local:../../agents/engineer", nodePath.join(root, "tree", "rigs", "team"), realFs);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it("L4: in that same layout, one more .. (out of the whole tree) is refused", () => {
    persona(nodePath.join(root, "tree", "agents", "engineer"), "engineer");
    fs.mkdirSync(nodePath.join(root, "tree", "rigs", "team"), { recursive: true });
    persona(nodePath.join(root, "elsewhere"), "elsewhere");
    refusedWith(resolveAgentRef("local:../../../elsewhere", nodePath.join(root, "tree", "rigs", "team"), realFs), "ref_refused", /outside/);
  });

  it("X8: a sibling folder whose name merely starts with the tree root's name is outside it (not a string-prefix test)", () => {
    persona(nodePath.join(root, "tree", "agents", "engineer"), "engineer");
    fs.mkdirSync(nodePath.join(root, "tree", "rigs", "team"), { recursive: true });
    persona(nodePath.join(root, "tree-evil", "agents", "p"), "p");
    refusedWith(resolveAgentRef("local:../../../tree-evil/agents/p", nodePath.join(root, "tree", "rigs", "team"), realFs), "ref_refused", /outside/);
  });

  it("X8b: the tree root's own parent folder is outside it", () => {
    persona(nodePath.join(root, "tree", "agents", "engineer"), "engineer");
    fs.mkdirSync(nodePath.join(root, "tree", "rigs", "team"), { recursive: true });
    persona(root, "parent");
    refusedWith(resolveAgentRef("local:../../..", nodePath.join(root, "tree", "rigs", "team"), realFs), "ref_refused", /outside/);
  });

  it("X4b: a folder with only rigs/ (no agents/) is not a spec tree root", () => {
    fs.mkdirSync(nodePath.join(root, "outer", "rigs"), { recursive: true });
    fs.mkdirSync(nodePath.join(root, "outer", "proj", "rig"), { recursive: true });
    persona(nodePath.join(root, "outer", "other", "p"), "p");
    refusedWith(resolveAgentRef("local:../../other/p", nodePath.join(root, "outer", "proj", "rig"), realFs), "ref_refused", /outside/);
  });

  it("X21: the NEAREST marked tree decides, even over the root the ref was reached under (a persona folder holding its own agents/ and rigs/ confines its imports to itself)", () => {
    const rig = nodePath.join(root, "rig");
    persona(nodePath.join(rig, "shared"), "shared");
    const impl = persona(nodePath.join(rig, "agents", "impl"), "impl", ["local:../../shared"]);
    fs.mkdirSync(nodePath.join(impl, "agents")); fs.mkdirSync(nodePath.join(impl, "rigs"));
    refusedWith(resolveAgentRef("local:agents/impl", rig, realFs), "import_error", /outside/);
  });

  it("X22 (OF-99): a local: ref that goes through an in-tree symlink is recorded as typed, and still confined by its real location", () => {
    persona(nodePath.join(root, "rig", "agents", "impl"), "impl");
    fs.symlinkSync(nodePath.join(root, "rig", "agents", "impl"), nodePath.join(root, "rig", "agents", "alias"));
    const r = resolveAgentRef("local:agents/alias", nodePath.join(root, "rig"), realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.resolved.sourcePath).toBe(nodePath.join(root, "rig", "agents", "alias"));
  });

  it("X23 (OF-99): a typed form that would name a DIFFERENT folder than the real one is not used: the real folder is recorded", () => {
    // lib/team -> tree/rigs/team. `local:../../agents/engineer` from the typed lib/team is lib/../agents = root/agents/engineer
    // (a decoy), but relative to the real location it is tree/agents/engineer, which is what resolves.
    persona(nodePath.join(root, "tree", "agents", "engineer"), "engineer");
    persona(nodePath.join(root, "agents", "engineer"), "decoy");
    fs.mkdirSync(nodePath.join(root, "tree", "rigs", "team"), { recursive: true });
    fs.mkdirSync(nodePath.join(root, "lib"));
    fs.symlinkSync(nodePath.join(root, "tree", "rigs", "team"), nodePath.join(root, "lib", "team"));
    const r = resolveAgentRef("local:../../agents/engineer", nodePath.join(root, "lib", "team"), realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      expect(r.resolved.spec.name).toBe("engineer");
      expect(r.resolved.sourcePath).toBe(nodePath.join(root, "tree", "agents", "engineer"));
    }
  });

  it("POSITIVE (release layout through a symlinked rig folder): refs are relative to the REAL location", () => {
    persona(nodePath.join(root, "tree", "agents", "engineer"), "engineer");
    fs.mkdirSync(nodePath.join(root, "tree", "rigs", "team"), { recursive: true });
    fs.mkdirSync(nodePath.join(root, "lib"));
    fs.symlinkSync(nodePath.join(root, "tree", "rigs", "team"), nodePath.join(root, "lib", "team"));
    const r = resolveAgentRef("local:../../agents/engineer", nodePath.join(root, "lib", "team"), realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("POSITIVE (documented layout, no rigs/ dir): a persona's import local:../../shared resolves inside the rig folder; one that climbs past the rig folder is refused", () => {
    persona(nodePath.join(root, "rig", "shared"), "shared");
    persona(nodePath.join(root, "rig", "agents", "impl"), "impl", ["local:../../shared"]);
    const rigRoot = nodePath.join(root, "rig");
    const ok = resolveAgentRef("local:agents/impl", rigRoot, realFs);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    if (ok) expect(ok.ok && ok.imports.map((i) => i.spec.name)).toEqual(["shared"]);
    persona(nodePath.join(root, "stray"), "stray");
    persona(nodePath.join(root, "rig", "agents", "bad"), "bad", ["local:../../../stray"]);
    const bad = resolveAgentRef("local:agents/bad", rigRoot, realFs);
    refusedWith(bad, "import_error", /outside .*use path:\/absolute\/dir/);
  });

  it("I1: an import through a symlink that resolves outside is refused", () => {
    persona(nodePath.join(root, "outside"), "outside");
    fs.mkdirSync(nodePath.join(root, "rig", "agents", "impl"), { recursive: true });
    fs.symlinkSync(nodePath.join(root, "outside"), nodePath.join(root, "rig", "shared"));
    persona(nodePath.join(root, "rig", "agents", "impl"), "impl", ["local:../../shared"]);
    refusedWith(resolveAgentRef("local:agents/impl", nodePath.join(root, "rig"), realFs), "import_error", /outside/);
  });

  it("POSITIVE (kernel layout): a path:-reached persona in a marked tree may import local:../../../shared inside that tree", () => {
    persona(nodePath.join(root, "specs", "agents", "shared"), "shared");
    fs.mkdirSync(nodePath.join(root, "specs", "rigs"), { recursive: true });
    persona(nodePath.join(root, "specs", "rigs", "kernel", "agents", "lead"), "lead", ["local:../../../../agents/shared"]);
    const r = resolveAgentRef(`path:${nodePath.join(root, "specs", "rigs", "kernel", "agents", "lead")}`, nodePath.join(root, "proj"), realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe("path: refs are normalised, checked by realpath and recorded as typed, with no allowlist", () => {
  it("P1: .. segments are normalised away (path:/a/../../b style) and the persona is found at the normalised place", () => {
    persona(nodePath.join(root, "b"), "b");
    fs.mkdirSync(nodePath.join(root, "a", "deep"), { recursive: true });
    const r = resolveAgentRef(`path:${root}/a/deep/../../b`, "/unused", realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.resolved.sourcePath).toBe(nodePath.join(root, "b"));
  });

  it("P2 (OF-99): a symlinked persona folder is CHECKED by its realpath but RECORDED as typed, so a later retarget is followed", () => {
    persona(nodePath.join(root, "real"), "real");
    persona(nodePath.join(root, "real2"), "real2");
    fs.symlinkSync(nodePath.join(root, "real"), nodePath.join(root, "link"));
    const first = resolveAgentRef(`path:${root}/link`, "/unused", realFs);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (first.ok) { expect(first.resolved.sourcePath).toBe(nodePath.join(root, "link")); expect(first.resolved.spec.name).toBe("real"); }
    fs.unlinkSync(nodePath.join(root, "link"));
    fs.symlinkSync(nodePath.join(root, "real2"), nodePath.join(root, "link"));
    const second = resolveAgentRef(`path:${root}/link`, "/unused", realFs);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (second.ok) { expect(second.resolved.sourcePath).toBe(nodePath.join(root, "link")); expect(second.resolved.spec.name).toBe("real2"); }
  });

  it("P2b (OF-99): a persona reached through a symlink imports local: siblings recorded as typed too (the release's shared persona follows `current`)", () => {
    persona(nodePath.join(root, "rel1", "agents", "lead"), "lead", ["local:../shared"]);
    persona(nodePath.join(root, "rel1", "agents", "shared"), "shared");
    fs.mkdirSync(nodePath.join(root, "rel1", "rigs"));
    fs.symlinkSync(nodePath.join(root, "rel1"), nodePath.join(root, "current"));
    const r = resolveAgentRef(`path:${root}/current/agents/lead`, "/unused", realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      expect(r.resolved.sourcePath).toBe(nodePath.join(root, "current", "agents", "lead"));
      expect(r.imports.map((i) => i.sourcePath)).toEqual([nodePath.join(root, "current", "agents", "shared")]);
    }
  });

  it("P2c (OF-99): an import cycle through a symlinked alias of the base persona is still detected by real location", () => {
    persona(nodePath.join(root, "real"), "real", ["path:" + nodePath.join(root, "alias")]);
    fs.symlinkSync(nodePath.join(root, "real"), nodePath.join(root, "alias"));
    const r = resolveAgentRef(`path:${root}/real`, "/unused", realFs);
    refusedWith(r, "cycle_detected", /already-visited/);
  });

  it("P2d (OF-99): a base persona reached through a symlink that imports its own real folder is a cycle (identity is the real location)", () => {
    persona(nodePath.join(root, "real"), "real", ["path:" + nodePath.join(root, "real")]);
    fs.symlinkSync(nodePath.join(root, "real"), nodePath.join(root, "alias"));
    const r = resolveAgentRef(`path:${root}/alias`, "/unused", realFs);
    refusedWith(r, "cycle_detected", /already-visited/);
  });

  it("P3: NO allowlist: an absolute path outside the rig resolves (the daemon caller is trusted)", () => {
    persona(nodePath.join(root, "anywhere", "personas", "x"), "x");
    fs.mkdirSync(nodePath.join(root, "rig"));
    const r = resolveAgentRef(`path:${root}/anywhere/personas/x`, nodePath.join(root, "rig"), realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("P4: a relative path: ref is refused (must be absolute)", () => {
    const r = resolveAgentRef("path:relative/dir", root, realFs);
    refusedWith(r, "ref_refused", /must be an absolute path/);
  });
});

describe("agent.yaml is read through the persona-file guard", () => {
  const manifest = (dir: string) => nodePath.join(dir, "agent.yaml");
  const resolveAt = (dir: string) => resolveAgentRef(`path:${dir}`, "/unused", realFs);

  it("the cap is 64 KiB (largest real agent.yaml is 2,115 bytes)", () => {
    expect(PERSONA_FILE_MAX_BYTES).toBe(CAP);
  });

  it("POSITIVE: a regular single-link agent.yaml, and one exactly at the cap, are accepted", () => {
    const d = persona(nodePath.join(root, "p"), "p");
    expect(resolveAt(d).ok).toBe(true);
    const text = fs.readFileSync(manifest(d), "utf-8");
    fs.writeFileSync(manifest(d), text + "#".repeat(CAP - Buffer.byteLength(text)));
    expect(fs.statSync(manifest(d)).size).toBe(CAP);
    const r = resolveAt(d);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("POSITIVE: an agent.yaml that is a symlink to a regular file elsewhere is followed (as for culture files)", () => {
    const d = nodePath.join(root, "p"); fs.mkdirSync(d);
    fs.writeFileSync(nodePath.join(root, "real.yaml"), AGENT("linked"));
    fs.symlinkSync(nodePath.join(root, "real.yaml"), manifest(d));
    expect(resolveAt(d).ok).toBe(true);
  });

  it("F1: one byte over the cap is refused with the cap in the message", () => {
    const d = persona(nodePath.join(root, "p"), "p");
    const text = fs.readFileSync(manifest(d), "utf-8");
    fs.writeFileSync(manifest(d), text + "#".repeat(CAP + 1 - Buffer.byteLength(text)));
    expect(fs.statSync(manifest(d)).size).toBe(CAP + 1);
    refusedWith(resolveAt(d), "ref_refused", new RegExp(`over the ${CAP}-byte limit`));
  });

  it("F2: a hard-linked agent.yaml is refused", () => {
    const d = persona(nodePath.join(root, "p"), "p");
    fs.linkSync(manifest(d), nodePath.join(root, "alias.yaml"));
    refusedWith(resolveAt(d), "ref_refused", /has 2 hard links/);
  });

  it("F3: an agent.yaml that is a directory is refused as not a regular file", () => {
    const d = nodePath.join(root, "p"); fs.mkdirSync(manifest(d), { recursive: true });
    refusedWith(resolveAt(d), "ref_refused", /is not a regular file/);
  });

  it("F4: a device file as agent.yaml is refused", () => {
    const d = nodePath.join(root, "p"); fs.mkdirSync(d);
    fs.symlinkSync("/dev/null", manifest(d));
    refusedWith(resolveAt(d), "ref_refused", /is not a regular file/);
  });

  it("F5: a FIFO agent.yaml WITH A WRITER ATTACHED is refused without hanging", async () => {
    const d = nodePath.join(root, "p"); fs.mkdirSync(d);
    execFileSync("mkfifo", [manifest(d)]);
    // `<>` opens the FIFO read-write, so a plain blocking read of it never sees EOF: the daemon-hang defect.
    const writer = spawn("sh", ["-c", 'exec 3<>"$1"; exec sleep 120', "sh", manifest(d)], { stdio: "ignore" });
    writers.push(writer);
    try {
      await new Promise((r) => setTimeout(r, 300));
      refusedWith(resolveAt(d), "ref_refused", /is not a regular file/);
    } finally {
      writer.kill("SIGKILL");
    }
  }, 15000);

  it("F7: a FIFO agent.yaml with NO writer (an open that would block) is refused without hanging (O_NONBLOCK)", () => {
    const d = nodePath.join(root, "p"); fs.mkdirSync(d);
    execFileSync("mkfifo", [manifest(d)]);
    refusedWith(resolveAt(d), "ref_refused", /is not a regular file/);
  }, 15000);

  it("F6: an imported persona's FIFO agent.yaml (writer attached) is refused as an import error", async () => {
    persona(nodePath.join(root, "rig", "agents", "impl"), "impl", ["local:../../shared"]);
    const shared = nodePath.join(root, "rig", "shared"); fs.mkdirSync(shared, { recursive: true });
    execFileSync("mkfifo", [manifest(shared)]);
    const writer = spawn("sh", ["-c", 'exec 3<>"$1"; exec sleep 120', "sh", manifest(shared)], { stdio: "ignore" });
    writers.push(writer);
    try {
      await new Promise((r) => setTimeout(r, 300));
      refusedWith(resolveAgentRef("local:agents/impl", nodePath.join(root, "rig"), realFs), "import_error", /is not a regular file/);
    } finally {
      writer.kill("SIGKILL");
    }
  }, 15000);
});

describe("the refusal reaches the preflight surface", () => {
  it("agentPreflight reports a refused local: ref as not ready, with the use-path: message", () => {
    persona(nodePath.join(root, "outside"), "outside");
    fs.mkdirSync(nodePath.join(root, "rig"));
    const out = agentPreflight("local:../outside", nodePath.join(root, "rig"), realFs);
    expect(out.ready).toBe(false);
    expect(out.errors.join(" ")).toMatch(/use path:\/absolute\/dir/);
  });
});

// workspaces-o9o.1: the ~/.agents release imported `path:/opt/homebrew/lib/node_modules/@openrig/cli/daemon/specs/agents/shared`
// in every agent.yaml, so it broke on any other install prefix (Linux: ~/.local/lib/node_modules). `shipped:<rel>` names
// the RUNNING install's own specs folder instead.
describe("shipped: refs resolve inside the running install's specs folder", () => {
  // The oracle is this checkout's specs folder, derived from the TEST's location, not from the module under test.
  const REPO_SPECS = nodePath.resolve(import.meta.dirname, "..", "specs");
  /** A fake install at `<root>/<prefix>/@openrig/cli/daemon/specs` holding one persona `agents/<name>`. */
  function install(prefix: string, name = "shared"): string {
    const specs = nodePath.join(root, prefix, "@openrig", "cli", "daemon", "specs");
    persona(nodePath.join(specs, "agents", name), name);
    return specs;
  }
  const at = (specs: string): AgentResolverFsOps => ({ ...realFs, shippedSpecsRoot: specs } as AgentResolverFsOps);

  it("SYMPTOM: a persona importing the running install's shared persona by shipped: resolves on THIS install (default root)", () => {
    persona(nodePath.join(root, "rig", "agents", "impl"), "impl", ["shipped:agents/shared"]);
    const r = resolveAgentRef("local:agents/impl", nodePath.join(root, "rig"), realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.imports.map((i) => i.sourcePath)).toEqual([nodePath.join(REPO_SPECS, "agents", "shared")]);
    expect(r.imports[0]!.spec.name).toBe("shared");
  });

  it("SYMPTOM (member ref): a rig member's shipped: agent_ref resolves to the running install's persona", () => {
    const r = resolveAgentRef("shipped:rigs/launch/kernel/agents/operator/agent", nodePath.join(root, "rig"), realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.resolved.sourcePath).toBe(nodePath.join(REPO_SPECS, "rigs", "launch", "kernel", "agents", "operator", "agent"));
  });

  it("the same ref follows whichever install is running: Homebrew and ~/.local prefixes each resolve to their own specs", () => {
    for (const prefix of ["opt/homebrew/lib/node_modules", "home/u/.local/lib/node_modules"]) {
      const specs = install(prefix);
      const r = resolveAgentRef("shipped:agents/shared", nodePath.join(root, "rig"), at(specs));
      expect(r.ok, `${prefix}: ${JSON.stringify(r)}`).toBe(true);
      if (r.ok) expect(r.resolved.sourcePath).toBe(nodePath.join(specs, "agents", "shared"));
    }
  });

  it("a symlinked install root (Homebrew: lib/node_modules/@openrig/cli -> Cellar) is recorded as typed and confined by its real location", () => {
    const cellarSpecs = install("Cellar/openrig/1.2.3/libexec/lib/node_modules");
    const linkParent = nodePath.join(root, "opt", "homebrew", "lib", "node_modules", "@openrig");
    fs.mkdirSync(linkParent, { recursive: true });
    fs.symlinkSync(nodePath.resolve(cellarSpecs, "..", ".."), nodePath.join(linkParent, "cli"));
    const linkedSpecs = nodePath.join(linkParent, "cli", "daemon", "specs");
    const r = resolveAgentRef("shipped:agents/shared", nodePath.join(root, "rig"), at(linkedSpecs));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.sourcePath).toBe(nodePath.join(linkedSpecs, "agents", "shared"));
    expect(fs.realpathSync(r.resolved.sourcePath)).toBe(nodePath.join(cellarSpecs, "agents", "shared"));
  });

  it("SH1: a .. that climbs out of the specs folder is refused, even when the target does not exist", () => {
    const specs = install("lib/node_modules");
    persona(nodePath.join(root, "lib", "node_modules", "@openrig", "cli", "daemon", "outside"), "outside");
    refusedWith(resolveAgentRef("shipped:../outside", nodePath.join(root, "rig"), at(specs)), "ref_refused", /outside .*installed OpenRig's specs folder/);
    refusedWith(resolveAgentRef("shipped:agents/../../nowhere", nodePath.join(root, "rig"), at(specs)), "ref_refused", /installed OpenRig's specs folder/);
  });

  it("SH1b: a lexical .. out of the specs folder is refused even when a symlink there points back inside (as L5 for local:)", () => {
    const specs = install("lib/node_modules");
    fs.symlinkSync(specs, nodePath.join(nodePath.dirname(specs), "specs-alias"));
    refusedWith(resolveAgentRef("shipped:../specs-alias/agents/shared", nodePath.join(root, "rig"), at(specs)), "ref_refused", /installed OpenRig's specs folder/);
  });

  it("SH4b: a shipped persona's local: import of a sibling inside the specs folder resolves, with no rigs/ marker around it", () => {
    const specs = install("lib/node_modules", "base");
    fs.writeFileSync(nodePath.join(specs, "agents", "base", "agent.yaml"), AGENT("base", ["local:../shared"]));
    persona(nodePath.join(specs, "agents", "shared"), "shared");
    const r = resolveAgentRef("shipped:agents/base", nodePath.join(root, "rig"), at(specs));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.imports.map((i) => i.sourcePath)).toEqual([nodePath.join(specs, "agents", "shared")]);
  });

  it("SH2: a symlink inside the specs folder that resolves outside it is refused after realpath", () => {
    const specs = install("lib/node_modules");
    persona(nodePath.join(root, "elsewhere"), "elsewhere");
    fs.symlinkSync(nodePath.join(root, "elsewhere"), nodePath.join(specs, "agents", "escape"));
    refusedWith(resolveAgentRef("shipped:agents/escape", nodePath.join(root, "rig"), at(specs)), "ref_refused", /resolves to .*elsewhere, outside /);
  });

  it("SH3: an absolute shipped: path is refused; an empty one cannot be resolved", () => {
    const specs = install("lib/node_modules");
    refusedWith(resolveAgentRef(`shipped:${nodePath.join(specs, "agents", "shared")}`, nodePath.join(root, "rig"), at(specs)), "ref_refused", /relative to the installed OpenRig's specs folder/);
    refusedWith(resolveAgentRef("shipped:", nodePath.join(root, "rig"), at(specs)), "not_found", /Cannot resolve agent_ref "shipped:"/);
  });

  it("SH4: a shipped persona's own local: import may not climb out of the specs folder", () => {
    const specs = install("lib/node_modules", "base");
    fs.writeFileSync(nodePath.join(specs, "agents", "base", "agent.yaml"), AGENT("base", ["local:../../../outside"]));
    // agents/base/../../.. is daemon/, one level above the specs folder.
    persona(nodePath.join(root, "lib", "node_modules", "@openrig", "cli", "daemon", "outside"), "outside");
    const r = resolveAgentRef("shipped:agents/base", nodePath.join(root, "rig"), at(specs));
    refusedWith(r, "import_error", /refused: .*outside /);
  });

  it("SH5: a scheme that only looks like shipped: is not one (Shipped:, shipped-x:)", () => {
    const specs = install("lib/node_modules");
    for (const ref of ["Shipped:agents/shared", "shipped-x:agents/shared"]) {
      refusedWith(resolveAgentRef(ref, nodePath.join(root, "rig"), at(specs)), "not_found", /Cannot resolve agent_ref/);
    }
  });
});

describe("agents-release: refs resolve inside the deployed agents release (workspaces-o9o.53)", () => {
  // Layout of a deployed release: <home>/.agents-release/<sha>/{agents,rigs}, `current` -> <sha>.
  let home: string;
  let releases: string;
  /** Remove group/other write from a fixture tree, so the rows hold under any umask (the release stage runs umask 0002). */
  function seal(dir: string): void {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) return;
    fs.chmodSync(dir, st.mode & 0o755);
    if (st.isDirectory()) for (const e of fs.readdirSync(dir)) seal(nodePath.join(dir, e));
  }
  function release(sha: string, version = "1.0"): string {
    const dir = nodePath.join(releases, sha);
    persona(nodePath.join(dir, "agents", "rsi-steward"), "rsi-steward", ["local:../shared"]);
    fs.writeFileSync(nodePath.join(dir, "agents", "rsi-steward", "agent.yaml"),
      AGENT("rsi-steward", ["local:../shared"]).replace('version: "1.0"', `version: "${version}"`));
    persona(nodePath.join(dir, "agents", "shared"), "shared");
    fs.mkdirSync(nodePath.join(dir, "rigs", "kernel"), { recursive: true });
    seal(home);
    return dir;
  }
  function point(sha: string): void {
    const link = nodePath.join(releases, "current");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(nodePath.join(releases, sha), link);
  }
  // The trust rule judged inside the fixture: ancestors above it read as the fixture's own (private) folder, and no temp
  // root, since the fixture lives under the system temp folder.
  function judgeIo(over: Record<string, Partial<fs.Stats>> = {}): PathJudgeIo {
    const above = (p: string) => { const rel = nodePath.relative(root, nodePath.resolve(p)); return rel.startsWith("..") || nodePath.isAbsolute(rel); };
    const patch = (p: string, st: fs.Stats) => (over[nodePath.resolve(p)] ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, over[nodePath.resolve(p)]) as fs.Stats : st);
    return {
      ...DEFAULT_PATH_JUDGE_IO,
      tempRoots: () => [],
      lstat: (p) => patch(p, above(p) ? fs.statSync(root) : fs.lstatSync(p)),
      stat: (p) => patch(p, above(p) ? fs.statSync(root) : fs.statSync(p)),
    };
  }
  const at = (io: PathJudgeIo = judgeIo()): AgentResolverFsOps =>
    ({ ...realFs, agentsReleaseRoot: nodePath.join(releases, "current"), pathJudgeIo: io } as AgentResolverFsOps);
  beforeEach(() => {
    home = nodePath.join(root, "home");
    releases = nodePath.join(home, ".agents-release");
    fs.mkdirSync(releases, { recursive: true, mode: 0o755 });
    release("aaaa111");
    point("aaaa111");
  });

  it("SYMPTOM: the improve pod's agents-release:agents/rsi-steward resolves through current, recorded as typed", () => {
    const r = resolveAgentRef("agents-release:agents/rsi-steward", nodePath.join(root, "instance", "kernel"), at());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.sourcePath).toBe(nodePath.join(releases, "current", "agents", "rsi-steward"));
    expect(fs.realpathSync(r.resolved.sourcePath)).toBe(nodePath.join(releases, "aaaa111", "agents", "rsi-steward"));
    // its own local: import resolves inside the release, through current too
    expect(r.imports.map((i) => i.sourcePath)).toEqual([nodePath.join(releases, "current", "agents", "shared")]);
  });

  it("AR1: after current is retargeted the same ref reaches the new release", () => {
    release("bbbb222", "2.0");
    point("bbbb222");
    const r = resolveAgentRef("agents-release:agents/rsi-steward", nodePath.join(root, "rig"), at());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.resolved.spec.version).toBe("2.0");
  });

  it("AR2: production's root is <home>/.agents-release/current, home from the daemon's own os.homedir() (the adapter)", () => {
    expect(deployedAgentsReleaseRoot("/h/u")).toBe("/h/u/.agents-release/current");
    const before = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      expect(deployedAgentsReleaseRoot()).toBe(nodePath.join(home, ".agents-release", "current"));
      const r = resolveAgentRef("agents-release:agents/rsi-steward", nodePath.join(root, "rig"),
        { ...realFs, agentsReleaseRoot: deployedAgentsReleaseRoot(), pathJudgeIo: judgeIo() } as AgentResolverFsOps);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) expect(r.resolved.sourcePath).toBe(nodePath.join(home, ".agents-release", "current", "agents", "rsi-steward"));
    } finally {
      if (before === undefined) delete process.env["HOME"]; else process.env["HOME"] = before;
    }
  });

  it("AR2b: a resolver given no deployed agents release refuses the ref instead of guessing a home", () => {
    refusedWith(resolveAgentRef("agents-release:agents/rsi-steward", nodePath.join(root, "rig"), { ...realFs, pathJudgeIo: judgeIo() } as AgentResolverFsOps),
      "ref_refused", /no deployed agents release/);
  });

  it("AR3: a .. that climbs out of the release is refused, even when the target does not exist", () => {
    persona(nodePath.join(releases, "outside"), "outside");
    refusedWith(resolveAgentRef("agents-release:../outside", nodePath.join(root, "rig"), at()), "ref_refused", /outside .*deployed agents release/);
    refusedWith(resolveAgentRef("agents-release:agents/../../nowhere", nodePath.join(root, "rig"), at()), "ref_refused", /deployed agents release/);
  });

  it("AR4: a symlink inside the release that resolves outside it is refused after realpath", () => {
    persona(nodePath.join(root, "elsewhere"), "elsewhere");
    fs.symlinkSync(nodePath.join(root, "elsewhere"), nodePath.join(releases, "aaaa111", "agents", "escape"));
    refusedWith(resolveAgentRef("agents-release:agents/escape", nodePath.join(root, "rig"), at()), "ref_refused", /resolves to .*elsewhere, outside /);
  });

  it("AR5: an absolute agents-release: path is refused; an empty one cannot be resolved", () => {
    refusedWith(resolveAgentRef(`agents-release:${nodePath.join(releases, "current", "agents", "rsi-steward")}`, nodePath.join(root, "rig"), at()), "ref_refused", /relative to the deployed agents release/);
    refusedWith(resolveAgentRef("agents-release:", nodePath.join(root, "rig"), at()), "not_found", /Cannot resolve agent_ref "agents-release:"/);
  });

  it("AR6: the persona's own local: import may not climb out of the release", () => {
    fs.writeFileSync(nodePath.join(releases, "aaaa111", "agents", "rsi-steward", "agent.yaml"), AGENT("rsi-steward", ["local:../../../outside"]));
    persona(nodePath.join(releases, "outside"), "outside");
    refusedWith(resolveAgentRef("agents-release:agents/rsi-steward", nodePath.join(root, "rig"), at()), "import_error", /refused: .*outside /);
  });

  it("AR6b: in a release with no rigs/ folder (no spec-tree marker), a persona's local: import of a sibling still resolves, confined to the release", () => {
    fs.rmSync(nodePath.join(releases, "aaaa111", "rigs"), { recursive: true });
    const r = resolveAgentRef("agents-release:agents/rsi-steward", nodePath.join(root, "rig"), at());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.imports.map((i) => i.sourcePath)).toEqual([nodePath.join(releases, "current", "agents", "shared")]);
  });

  it("AR7: a persona folder writable by group or others is refused (the release is the user's own, judged by ownership)", () => {
    fs.chmodSync(nodePath.join(releases, "aaaa111", "agents", "rsi-steward"), 0o775);
    refusedWith(resolveAgentRef("agents-release:agents/rsi-steward", nodePath.join(root, "rig"), at()), "ref_refused", /writable by group or others/);
  });

  it("AR8: a release folder owned by another user is refused", () => {
    const io = judgeIo({ [nodePath.join(releases, "aaaa111")]: { uid: 4242 } });
    refusedWith(resolveAgentRef("agents-release:agents/rsi-steward", nodePath.join(root, "rig"), at(io)), "ref_refused", /owned by uid 4242/);
  });

  it("AR9: a current pointed into a git work tree (a checkout, not a reviewed release) is refused", () => {
    fs.mkdirSync(nodePath.join(releases, "aaaa111", ".git"));
    refusedWith(resolveAgentRef("agents-release:agents/rsi-steward", nodePath.join(root, "rig"), at()), "ref_refused", /git work tree/);
  });

  it("AR10: with the production judge, a release under a temp folder is refused (the rule is wired to the real io)", () => {
    refusedWith(resolveAgentRef("agents-release:agents/rsi-steward", nodePath.join(root, "rig"), at(DEFAULT_PATH_JUDGE_IO)), "ref_refused", /persona folder/);
  });

  it("AR11: a scheme that only looks like agents-release: is not one", () => {
    for (const ref of ["Agents-release:agents/rsi-steward", "agents-release-x:agents/rsi-steward", "agents_release:agents/rsi-steward"]) {
      refusedWith(resolveAgentRef(ref, nodePath.join(root, "rig"), at()), "not_found", /Cannot resolve agent_ref/);
    }
  });
});

describe("census pins: every production filesystem the resolver is given carries the guard", () => {
  const src = (rel: string) => fs.readFileSync(nodePath.join(import.meta.dirname, "..", "src", rel), "utf-8");

  it("the set of source files that call resolveAgentRef is exactly the reviewed set (a new caller must be reviewed here)", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = nodePath.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && /\bresolveAgentRef\(/.test(fs.readFileSync(p, "utf-8"))) callers.push(nodePath.relative(nodePath.join(import.meta.dirname, "..", "src"), p));
      }
    };
    walk(nodePath.join(import.meta.dirname, "..", "src"));
    expect(callers.sort()).toEqual([
      "domain/agent-preflight.ts",
      "domain/agent-resolver.ts",
      "domain/pod-bundle-assembler.ts",
      "domain/rigspec-instantiator.ts",
      "domain/rigspec-preflight.ts",
    ]);
  });

  it("the four production constructions of a resolver filesystem spread guardedAgentRefFsOps", () => {
    // startup.ts: resolverFsOps (bundle install/bootstrap) and the PodRigInstantiator fsOps (up, add, grow, expand);
    // routes/rigspec.ts: the preflight route; routes/bundles.ts: bundle create.
    expect(src("startup.ts")).toMatch(/const resolverFsOps = \{\s*\.\.\.guardedAgentRefFsOps,/);
    expect(src("startup.ts")).toMatch(/new PodRigInstantiator\(\{[\s\S]*?fsOps: \{ \.\.\.guardedAgentRefFsOps,/);
    expect(src("routes/rigspec.ts")).toMatch(/const fsOps = \{ \.\.\.guardedAgentRefFsOps,/);
    expect(src("routes/bundles.ts")).toMatch(/function podAssemblerFsOps\(\)[\s\S]*?\.\.\.guardedAgentRefFsOps,/);
  });

  it("workspaces-o9o.53: each of the four hands the resolver the deployed agents release, from the adapter", () => {
    expect(src("startup.ts")).toMatch(/const resolverFsOps = \{\s*\.\.\.guardedAgentRefFsOps,\s*agentsReleaseRoot: deployedAgentsReleaseRoot\(\),/);
    expect(src("startup.ts")).toMatch(/new PodRigInstantiator\(\{[\s\S]*?fsOps: \{ \.\.\.guardedAgentRefFsOps, agentsReleaseRoot: deployedAgentsReleaseRoot\(\),/);
    expect(src("routes/rigspec.ts")).toMatch(/const fsOps = \{ \.\.\.guardedAgentRefFsOps, agentsReleaseRoot: deployedAgentsReleaseRoot\(\),/);
    expect(src("routes/bundles.ts")).toMatch(/function podAssemblerFsOps\(\)[\s\S]*?\.\.\.guardedAgentRefFsOps,\s*agentsReleaseRoot: deployedAgentsReleaseRoot\(\),/);
  });
});
