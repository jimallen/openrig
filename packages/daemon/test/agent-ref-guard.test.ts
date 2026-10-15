import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { resolveAgentRef, type AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import { agentPreflight } from "../src/domain/agent-preflight.js";
import { PERSONA_FILE_MAX_BYTES, guardedAgentRefFsOps } from "../src/domain/agent-ref-guard.js";

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

describe("path: refs are normalised and realpath'd, with no allowlist", () => {
  it("P1: .. segments are normalised away (path:/a/../../b style) and the persona is found at the normalised place", () => {
    persona(nodePath.join(root, "b"), "b");
    fs.mkdirSync(nodePath.join(root, "a", "deep"), { recursive: true });
    const r = resolveAgentRef(`path:${root}/a/deep/../../b`, "/unused", realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.resolved.sourcePath).toBe(nodePath.join(root, "b"));
  });

  it("P2: a symlinked persona folder is realpath'd, so a later retarget cannot change what was resolved", () => {
    persona(nodePath.join(root, "real"), "real");
    fs.symlinkSync(nodePath.join(root, "real"), nodePath.join(root, "link"));
    const r = resolveAgentRef(`path:${root}/link`, "/unused", realFs);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.resolved.sourcePath).toBe(nodePath.join(root, "real"));
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
});
