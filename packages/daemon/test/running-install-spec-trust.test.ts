// workspaces-o9o.91. On stu the running install lives in Homebrew's prefix (/opt/homebrew/lib/node_modules/@openrig/cli), and
// /opt/homebrew is a git checkout, so the git-tree rule judged the install's OWN bundled specs untrusted: a kernel seat could not
// be relaunched fresh from the spec the kernel boot recorded (startup_source_untrusted), and rig doctor failed the folder.
// The daemon runs code from <install>/daemon/dist, so whatever can change <install>/daemon/specs can change the code it runs: a
// git tree that ENCLOSES the running install's daemon folder adds nothing. That one location rule is waived for the running
// install, compared by identity; every other rule stays, and a git tree inside the install still counts.
//
// The prefix is built on the real filesystem (identity is dev:ino, and the git-tree rule looks for a real .git) in a trusted
// base outside temp, since the judge refuses every temp location; modes are set the way Homebrew installs them.
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { judgeSpecSource, specSourceTrustOf } from "../src/domain/recorded-spec-source-judge.js";
import { DEFAULT_PATH_JUDGE_IO, specFileTrustProblem } from "../src/domain/codex-mcp-servers.js";
import { runningShippedSpecsRoot } from "../src/domain/builtin-startup-files.js";
import { judgeSpecRoots } from "../src/domain/host-readiness.js";
import { readTrustedSeatSpec } from "../src/domain/seat-mcp-servers.js";
import { makeTrustedBase } from "./helpers/trusted-scaffold.js";

const KERNEL = "rigs/launch/kernel/rig.yaml";
const bases: string[] = [];
afterAll(() => { for (const b of bases) rmSync(b, { recursive: true, force: true }); });

/** Remove group and other write from everything under `root` (the umask here is 0002; Homebrew installs 0755/0644). */
function homebrewModes(root: string): void {
  const walk = (p: string) => {
    const st = statSync(p);
    chmodSync(p, st.mode & 0o755);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
  };
  walk(root);
}

/** A packaged install under a prefix: <prefix>/lib/node_modules/@openrig/cli/daemon/{dist,specs}, with the kernel spec. */
function install(prefix: string): { daemon: string; specs: string; kernel: string } {
  const daemon = join(prefix, "lib", "node_modules", "@openrig", "cli", "daemon");
  const specs = join(daemon, "specs");
  mkdirSync(join(specs, "rigs", "launch", "kernel"), { recursive: true });
  mkdirSync(join(daemon, "dist"), { recursive: true });
  copyFileSync(join(runningShippedSpecsRoot(), KERNEL), join(specs, KERNEL));
  return { daemon, specs, kernel: join(specs, KERNEL) };
}

function scaffold(opts: { prefixGit?: boolean } = {}) {
  const base = makeTrustedBase("o9o91-");
  bases.push(base);
  const prefix = join(base, "homebrew");
  mkdirSync(prefix);
  if (opts.prefixGit !== false) mkdirSync(join(prefix, ".git"));
  const inst = install(prefix);
  homebrewModes(base);
  const trust = specSourceTrustOf({ specRoots: () => [inst.specs], runningInstall: () => inst.daemon, io: DEFAULT_PATH_JUDGE_IO });
  return { base, prefix, ...inst, trust };
}

const judge = (s: ReturnType<typeof scaffold>, specSource: string, use: "read" | "record", seatFolders: string[] = []) =>
  judgeSpecSource({ specSource, use, rigName: "kernel", seatFolders, trust: s.trust });

describe("o9o.91: the running install's own bundled specs are trusted inside an enclosing git tree", () => {
  it("RED: the kernel spec the kernel boot records is trusted for a fresh re-read and for recording, under a git-checkout prefix", () => {
    const s = scaffold();
    expect(judge(s, s.kernel, "read")).toEqual({ ok: true, readPath: s.kernel });
    expect(judge(s, s.kernel, "record")).toEqual({ ok: true, readPath: s.kernel });
  });

  it("RED: rig doctor's spec-folder row passes the running install's specs folder under a git-checkout prefix", () => {
    const s = scaffold();
    expect(judgeSpecRoots(s.trust, DEFAULT_PATH_JUDGE_IO)).toMatchObject({ status: "pass" });
  });

  it("the git-checkout prefix is the only thing that changes the answer (control: the same install with no .git)", () => {
    const s = scaffold({ prefixGit: false });
    expect(judge(s, s.kernel, "read").ok).toBe(true);
  });
});

describe("o9o.91: the waiver opens nothing else (negative controls)", () => {
  it("a spec in another git checkout, not the running install, is still refused", () => {
    const s = scaffold();
    const repo = join(s.base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "specs"));
    writeFileSync(join(repo, "specs", "rig.yaml"), "name: kernel\npods: []\n");
    homebrewModes(repo);
    const trust = specSourceTrustOf({ specRoots: () => [join(repo, "specs")], runningInstall: () => s.daemon, io: DEFAULT_PATH_JUDGE_IO });
    const r = judgeSpecSource({ specSource: join(repo, "specs", "rig.yaml"), use: "read", rigName: "kernel", seatFolders: [], trust });
    expect(r).toMatchObject({ ok: false, code: "spec_untrusted" });
    expect(!r.ok && r.message).toContain(`lies inside the git work tree ${repo}`);
  });

  it("a git checkout INSIDE the running install still counts", () => {
    const s = scaffold();
    mkdirSync(join(s.specs, ".git"));
    homebrewModes(s.specs);
    const r = judge(s, s.kernel, "read");
    expect(r).toMatchObject({ ok: false, code: "spec_untrusted" });
    expect(!r.ok && r.message).toContain(`lies inside the git work tree ${s.specs}`);
  });

  it("a seat whose working folder covers the install is still refused", () => {
    const s = scaffold();
    const r = judge(s, s.kernel, "read", [s.prefix]);
    expect(r).toMatchObject({ ok: false, code: "spec_untrusted" });
    expect(!r.ok && r.message).toContain("the seat's working directory");
  });

  it("a group-writable install is still refused: only the location rule is waived", () => {
    const s = scaffold();
    chmodSync(s.specs, 0o775);
    const r = judge(s, s.kernel, "read");
    expect(r).toMatchObject({ ok: false, code: "spec_untrusted" });
    expect(!r.ok && r.message).toContain("writable by group or others");
  });

  it("with no running install named, the git-tree rule applies to the install as before", () => {
    const s = scaffold();
    const trust = specSourceTrustOf({ specRoots: () => [s.specs], io: DEFAULT_PATH_JUDGE_IO });
    const r = judgeSpecSource({ specSource: s.kernel, use: "read", rigName: "kernel", seatFolders: [], trust });
    expect(r).toMatchObject({ ok: false, code: "spec_untrusted" });
  });

  it("an operator-named spec file (set-mcp --spec) inside the running install gets the same answer", () => {
    const s = scaffold();
    expect(specFileTrustProblem(s.kernel, [s.specs], null, DEFAULT_PATH_JUDGE_IO, { runningInstall: s.daemon })).toBeNull();
    expect(specFileTrustProblem(s.kernel, [s.specs], null, DEFAULT_PATH_JUDGE_IO)).toContain("lies inside the git work tree");
  });
});

describe("o9o.91: the install is matched by identity, never through a link", () => {
  it("a link elsewhere that leads into the install is not the install: the git checkout holding the link still counts", () => {
    const s = scaffold();
    const repo = join(s.base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    symlinkSync(s.daemon, join(repo, "link"));
    homebrewModes(repo);
    const viaLink = join(repo, "link", "specs", KERNEL);
    expect(specFileTrustProblem(viaLink, [s.specs], null, DEFAULT_PATH_JUDGE_IO, { runningInstall: s.daemon })).toContain(`lies inside the git work tree ${repo}`);
    // The real spelling of the same file is the install's own, and passes.
    expect(specFileTrustProblem(s.kernel, [s.specs], null, DEFAULT_PATH_JUDGE_IO, { runningInstall: s.daemon })).toBeNull();
  });
});

describe("o9o.91: set-mcp's operator-named spec carries the install through readTrustedSeatSpec", () => {
  it("a spec named with --spec inside the running install is not refused as untrusted", () => {
    const s = scaffold();
    const read = (runningInstall?: () => string | null) => readTrustedSeatSpec({
      specSource: null, operatorSpecFile: s.kernel, rigName: "kernel", node: { logicalId: "operator.agent", cwd: null },
      purpose: "MCP servers", trustedSpecRoots: [s.specs], io: DEFAULT_PATH_JUDGE_IO, ...(runningInstall ? { runningInstall } : {}),
    });
    const withInstall = read(() => s.daemon);
    expect(withInstall.ok || withInstall.kind).not.toBe("file_untrusted");
    expect(read()).toMatchObject({ ok: false, kind: "file_untrusted" });
  });
});

describe("o9o.91: rig doctor's fix text names the remedy for the finding's kind", () => {
  it("a spec folder inside a git checkout is told to move out of it, never to chmod or chown", () => {
    const s = scaffold();
    const repo = join(s.base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "specs"));
    homebrewModes(repo);
    const row = judgeSpecRoots({ roots: () => [join(repo, "specs")], runningInstall: () => s.daemon }, DEFAULT_PATH_JUDGE_IO);
    expect(row.status).toBe("fail");
    expect(row.fix).toMatch(/git work tree/);
    expect(row.fix).not.toMatch(/chmod|chown/);
  });

  it("a group-writable spec folder is still told chmod go-w", () => {
    const s = scaffold({ prefixGit: false });
    chmodSync(s.specs, 0o775);
    const row = judgeSpecRoots(s.trust, DEFAULT_PATH_JUDGE_IO);
    expect(row.status).toBe("fail");
    expect(row.fix).toContain("chmod go-w");
    expect(row.fix).not.toMatch(/git work tree/);
  });
});
