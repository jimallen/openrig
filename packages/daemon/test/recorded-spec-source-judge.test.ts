// OF-103 / OF-104 / OF-49: the ONE judgement of a rig's spec source, applied when it is recorded and again at every read.
// Production consequence pinned here: a rig's recorded spec source decides which startup files, culture and `local:` personas
// a later fresh launch or restore delivers into a live seat, and which MCP servers `rig seat set-mcp` trusts. Every reader
// (readSeatStartupFromSpec, readDeclaredMcpServer, `spec-source show`) and `spec-source set` call judgeSpecSource, so a rig
// recorded by `rig up` before OF-102, a link retargeted, or a file swapped after `set`, is held to the same rules.
// Deployed entrypoint: startup.ts constructs PodRigInstantiator with specSourceTrust (the MCP spec roots) and passes the same
// roots as mcpTrust to SeatLifecycleService; routes/rig-spec-source.ts builds RigSpecSourceService with specSourceTrustOf.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeSpecSource, specSourceTrustOf, type SpecSourceTrust } from "../src/domain/recorded-spec-source-judge.js";
import { specFileTrustProblem } from "../src/domain/codex-mcp-servers.js";
import { runningShippedSpecsRoot } from "../src/domain/builtin-startup-files.js";
import { PERMISSIVE_JUDGE_IO } from "./helpers/spec-source-trust.js";

const SPEC = (name: string) => `version: "0.2"\nname: ${name}\npods:\n  - id: dev\n    label: dev\n    members:\n      - id: impl\n        agent_ref: "local:agents/impl"\n        profile: default\n        runtime: claude-code\n        cwd: .\n    edges: []\nedges: []\n`;

describe("OF-103 judgeSpecSource: one judgement for record and read", () => {
  let root: string;
  let trusted: string;      // a general trusted root (released copies, spec library)
  let exact: string;        // the shared-docs rigs folder: exact depth only
  let outside: string;      // under no root
  let trust: SpecSourceTrust;

  const write = (base: string, rel: string, text = SPEC("team")) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const read = (specSource: string, over: { rigName?: string; seatFolders?: string[]; trust?: SpecSourceTrust } = {}) =>
    judgeSpecSource({ specSource, use: "read", rigName: over.rigName ?? "team", seatFolders: over.seatFolders ?? [], trust: over.trust ?? trust });
  const record = (specSource: string, over: { rigName?: string; trust?: SpecSourceTrust } = {}) =>
    judgeSpecSource({ specSource, use: "record", rigName: over.rigName ?? "team", seatFolders: [], trust: over.trust ?? trust });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of103-")));
    trusted = path.join(root, "trusted");
    exact = path.join(root, "shared-docs", "rigs");
    outside = path.join(root, "outside");
    for (const d of [trusted, exact, outside]) fs.mkdirSync(d, { recursive: true });
    trust = { roots: () => [trusted], exactDepthRoot: () => exact, io: PERMISSIVE_JUDGE_IO };
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  describe("at a read", () => {
    it("accepts a spec under a general root, and exactly <shared-docs rigs>/<name>/rig.yaml; the path it reads is the path it judged", () => {
      const general = write(trusted, "rel/rigs/team/rig.yaml");
      const kernelShape = write(exact, "team/rig.yaml");
      expect(read(general)).toEqual({ ok: true, readPath: general });
      expect(read(kernelShape)).toEqual({ ok: true, readPath: kernelShape });
    });

    it("refuses a spec under no trusted root, naming the rule and the way out", () => {
      const file = write(outside, "rig.yaml");
      const judged = read(file);
      expect(judged).toMatchObject({ ok: false, code: "spec_untrusted" });
      if (!judged.ok) {
        expect(judged.message).toContain("is not under a trusted spec root");
        expect(judged.message).toContain("rig spec-source set");
        expect(judged.message).toContain("--startup-from stored");
      }
    });

    it("a source recorded before OF-102 (any path) is judged like one typed to `set`", () => {
      // Nothing about how a value got into rigs.spec_source_path counts: the same file refused at record is refused at read.
      const file = write(outside, "legacy/rig.yaml");
      expect(record(file)).toMatchObject({ ok: false, code: "spec_untrusted" });
      expect(read(file)).toMatchObject({ ok: false, code: "spec_untrusted" });
    });

    it("L1: a link kept in a seat-writable state folder is refused as typed, though it leads to a good file", () => {
      const good = write(exact, "team/rig.yaml");
      fs.mkdirSync(path.join(exact, "team", "state", "queue"), { recursive: true });
      const link = path.join(exact, "team", "state", "queue", "rig.yaml");
      fs.symlinkSync(good, link);
      const judged = read(link);
      expect(judged).toMatchObject({ ok: false, code: "spec_untrusted" });
      if (!judged.ok) expect(judged.message).toContain("as typed");
    });

    it("a real file deeper than <name>/rig.yaml is refused (a Codex state folder is seat-writable)", () => {
      const deep = write(exact, "team/state/queue/rig.yaml");
      expect(read(deep)).toMatchObject({ ok: false, code: "spec_untrusted" });
    });

    it("the shared-docs folder must be named for this rig or for the spec: another rig's folder is refused, the spec's own name is accepted", () => {
      const other = write(exact, "other/rig.yaml", SPEC("zzz"));
      const wrong = read(other, { rigName: "team" });
      expect(wrong).toMatchObject({ ok: false, code: "spec_untrusted" });
      if (!wrong.ok) expect(wrong.message).toContain("neither this rig's name ('team') nor its spec's name ('zzz')");
      expect(read(other, { rigName: "other" })).toMatchObject({ ok: true });
      const bySpecName = write(exact, "zzz/rig.yaml", SPEC("zzz"));
      expect(read(bySpecName, { rigName: "project-rig-name" })).toMatchObject({ ok: true });
    });

    it("a spec inside one of the rig's seat folders is refused even under a trusted root", () => {
      const file = write(trusted, "ws/rig.yaml");
      expect(read(file)).toMatchObject({ ok: true });
      expect(read(file, { seatFolders: [path.join(trusted, "ws")] })).toMatchObject({ ok: false, code: "spec_untrusted" });
    });

    it("a spec with a second hard link is refused", () => {
      const file = write(trusted, "rel/rig.yaml");
      fs.linkSync(file, path.join(outside, "alias.yaml"));
      expect(read(file)).toMatchObject({ ok: false, code: "spec_untrusted" });
    });

    it("a missing file is the reader's own 'unavailable' (spec_unreadable), not a trust refusal", () => {
      expect(read(path.join(trusted, "gone", "rig.yaml"))).toMatchObject({ ok: false, code: "spec_unreadable" });
    });

    it("a link whose target moved outside the root after it was recorded is refused where it now leads", () => {
      const first = write(trusted, "rel-a/rig.yaml");
      fs.mkdirSync(path.join(trusted, "library"));
      const link = path.join(trusted, "library", "rig.yaml");
      fs.symlinkSync(first, link);
      expect(read(link)).toMatchObject({ ok: true });
      fs.unlinkSync(link);
      fs.symlinkSync(write(outside, "evil/rig.yaml"), link);
      expect(read(link)).toMatchObject({ ok: false, code: "spec_untrusted" });
    });
  });

  // A dev-checkout-shaped spelling is re-anchored to the running install's specs only while the file is missing (T6): the
  // read judges the path it will actually read, and judges it again once someone creates the spelling.
  describe("a dev-checkout-shaped spelling at a read", () => {
    const bundled = runningShippedSpecsRoot();
    const kernelRel = path.join("rigs", "launch", "kernel", "rig.yaml");
    // (The bundled specs of a checkout sit in a git work tree, which the judge refuses wherever the roots point, so these rows
    // pin WHICH file was judged through the refusal's own text rather than through an acceptance.)
    it("a missing spelling is judged as the running install's bundled file it re-anchors to, not as the spelling", () => {
      const spelling = path.join(outside, "dev", "packages", "daemon", "specs", kernelRel);
      expect(fs.existsSync(spelling)).toBe(false);
      expect(fs.existsSync(path.join(bundled, kernelRel))).toBe(true);
      for (const roots of [[bundled], []]) {
        const judged = read(spelling, { rigName: "kernel", trust: { ...trust, roots: () => roots } });
        expect(judged).toMatchObject({ ok: false, code: "spec_untrusted" });
        if (!judged.ok) {
          expect(judged.message).toContain(path.join(bundled, kernelRel));
          expect(judged.message).not.toContain(spelling);
        }
      }
    });
    it("T6 at the read: once the spelling exists, the file at the spelling is what is judged, and an outside folder is refused", () => {
      const spelling = write(outside, path.join("dev", "packages", "daemon", "specs", kernelRel));
      const judged = read(spelling, { rigName: "kernel", trust: { ...trust, roots: () => [bundled] } });
      expect(judged).toMatchObject({ ok: false, code: "spec_untrusted" });
      if (!judged.ok) expect(judged.message).toContain(spelling);
    });
  });

  describe("at a record (OF-104)", () => {
    it("refuses a packaged-install-shaped path outside the running install: a launch always reads the running install's file instead", () => {
      const other = write(trusted, path.join("old", "node_modules", "@openrig", "cli", "daemon", "specs", "rigs", "team", "rig.yaml"));
      const judged = record(other);
      expect(judged).toMatchObject({ ok: false, code: "spec_packaged_elsewhere" });
      if (!judged.ok) {
        expect(judged.message).toContain("other than the running one");
        expect(judged.message).toContain(path.join(runningShippedSpecsRoot(), "rigs", "team", "rig.yaml"));
      }
      // The same path is a different matter at a READ: the reader judges the file a launch reads (the re-anchored one).
      expect(read(other)).toMatchObject({ ok: false });
    });
    it("controls: a dev-checkout-shaped path that exists, and a file in the running install, are recorded as they are", () => {
      const dev = write(trusted, path.join("dev", "packages", "daemon", "specs", "rigs", "team", "rig.yaml"));
      expect(record(dev)).toEqual({ ok: true, readPath: dev });
      // A file inside the running install reads as itself, so it is never "elsewhere" (a checkout's git work tree refuses it for another reason).
      const bundledKernel = path.join(runningShippedSpecsRoot(), "rigs", "launch", "kernel", "rig.yaml");
      const inside = record(bundledKernel, { rigName: "kernel", trust: { ...trust, roots: () => [runningShippedSpecsRoot()] } });
      expect(inside.ok || inside.code !== "spec_packaged_elsewhere").toBe(true);
    });
    it("a link spelling of the running install is the same file a launch reads, so it is not 'elsewhere'", () => {
      // <outside>/nm/@openrig/cli/daemon/specs is a link to the running install's specs: packaged-shaped, re-anchored to the
      // running specs root, and leading to the very same file.
      const install = path.join(outside, "nm", "@openrig", "cli", "daemon");
      fs.mkdirSync(install, { recursive: true });
      fs.symlinkSync(runningShippedSpecsRoot(), path.join(install, "specs"));
      const spelling = path.join(install, "specs", "rigs", "launch", "kernel", "rig.yaml");
      expect(fs.existsSync(spelling)).toBe(true);
      const judged = record(spelling, { rigName: "kernel", trust: { ...trust, roots: () => [runningShippedSpecsRoot()] } });
      expect(judged.ok || judged.code !== "spec_packaged_elsewhere").toBe(true);
    });
    it("a missing path is refused as not existing (T6), and nothing is re-anchored", () => {
      const missing = path.join(trusted, "dev", "packages", "daemon", "specs", "rigs", "launch", "kernel", "rig.yaml");
      expect(record(missing, { rigName: "kernel", trust: { ...trust, roots: () => [runningShippedSpecsRoot()] } })).toMatchObject({ ok: false, code: "spec_unreadable" });
    });
  });

  // A source pin, in the repo's own style (agent-ref-guard.test.ts reads startup.ts the same way): the instantiator refuses every
  // recorded source when it carries no trust, so the production constructor must be handed the MCP spec roots, and the same
  // roots must reach SeatLifecycleService (mcpTrust) for the MCP read.
  describe("production wiring (startup.ts)", () => {
    const startup = fs.readFileSync(path.resolve(import.meta.dirname, "../src/startup.ts"), "utf-8");
    it("hands PodRigInstantiator the MCP spec roots as its recorded-source trust", () => {
      expect(startup).toMatch(/new PodRigInstantiator\(\{[\s\S]*?specSourceTrust: specSourceTrustOf\(\{ specRoots: \(\) => mcpTrust\.specRoots\(\) \}\)/);
    });
    it("passes the same mcpTrust to the app deps (SeatLifecycleService, the spec-source route)", () => {
      expect(startup).toMatch(/\n    mcpTrust,\n/);
      expect(startup).toMatch(/const mcpTrust = \{ specRoots: \(\) => mcpSpecRoots\(\{ home: daemonHome,/);
    });
  });

  describe("the daemon's own trust (specSourceTrustOf)", () => {
    it("takes the roots from the MCP trust it is given, and its shared-docs rigs folder from the daemon's home, never from a caller", () => {
      const built = specSourceTrustOf({ specRoots: () => ["/a", "/b"] });
      expect(built.roots()).toEqual(["/a", "/b"]);
      expect(built.exactDepthRoot!()).toMatch(/shared-docs[\\/]rigs$/);
      expect(specSourceTrustOf(undefined).roots()).toEqual([]);   // no roots wired: nothing is trusted, it never fails open
    });
  });
});

// OF-49 T4: the regular-file rule of specFileTrustProblem was never pinned. A directory (or any non-file) named like a spec
// must be refused by the rule itself, whatever the roots say.
describe("OF-49 specFileTrustProblem: the regular-file rule and the message for another install's specs", () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "of49-"))); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("T4: a directory named rig.yaml under a trusted root is refused as not a regular file; the control file is accepted", () => {
    const dir = path.join(root, "rig.yaml");
    fs.mkdirSync(dir);
    expect(specFileTrustProblem(dir, [root], null, PERMISSIVE_JUDGE_IO)).toContain("is not a regular file");
    const file = path.join(root, "sub", "rig.yaml");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, SPEC("team"));
    expect(specFileTrustProblem(file, [root], null, PERMISSIVE_JUDGE_IO)).toBeNull();
  });

  it("a spec in another OpenRig install's bundled specs is told so, instead of the general 'not under a trusted spec root'", () => {
    const other = path.join(root, "old", "node_modules", "@openrig", "cli", "daemon", "specs", "rigs", "team", "rig.yaml");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, SPEC("team"));
    const problem = specFileTrustProblem(other, [path.join(root, "release")], null, PERMISSIVE_JUDGE_IO)!;
    expect(problem).toContain("bundled specs of another OpenRig install");
    expect(problem).toContain(runningShippedSpecsRoot());
    // An ordinary outside path keeps the general wording.
    const plain = path.join(root, "plain", "rig.yaml");
    fs.mkdirSync(path.dirname(plain));
    fs.writeFileSync(plain, SPEC("team"));
    expect(specFileTrustProblem(plain, [path.join(root, "release")], null, PERMISSIVE_JUDGE_IO)).toContain("is not under a trusted spec root");
  });
});
