// z3 - merged-worktree cleanup. Every test drives REAL git on temp repositories (no mocks of git);
// the only injected seams are the process-cwd probe and the clock. The consequence under test is
// data loss: a sweep that removes a worktree holding uncommitted changes or unmerged commits.
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { createProgram } from "../src/index.js";
import { parseDuration, parseWorktreeList, renderSweepReport, sweepWorktrees, type CwdProbeResult, type RepoReport, type WorktreeVerdict } from "../src/worktree-sweep.js";

const NOBODY_HOME: CwdProbeResult = { cwds: [], unreadable: 0 };
const noProbe = async (): Promise<CwdProbeResult> => NOBODY_HOME;
// Far from wall clock on purpose: a clock-reversion mutant must not hide behind "now".
const TEN_DAYS_LATER = (): number => Date.now() + 10 * 86_400_000;

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture {
  root: string;
  repo: string;
  origin: string;
  wt: (name: string) => string;
  addWorktree: (name: string) => string;
  /** Commit a file inside the worktree, then fast-forward origin/main to include it. */
  commitAndMerge: (name: string) => void;
}

const roots: string[] = [];
function makeFixture(opts: { originHead?: boolean } = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "z3-sweep-")));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "code", "repo");
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "init", "-b", "main", repo);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "seed");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  if (opts.originHead !== false) git(repo, "remote", "set-head", "origin", "main");
  const wt = (name: string): string => path.join(root, "code", name);
  return {
    root,
    repo,
    origin,
    wt,
    addWorktree: (name) => {
      git(repo, "worktree", "add", "-b", name, wt(name));
      return wt(name);
    },
    commitAndMerge: (name) => {
      fs.writeFileSync(path.join(wt(name), `${name}.txt`), `${name}\n`);
      git(wt(name), "add", ".");
      git(wt(name), "commit", "-m", `work ${name}`);
      git(repo, "merge", "--ff-only", name);
      git(repo, "push", "origin", "main");
    },
  };
}

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function sweep(f: Fixture, o: { apply?: boolean; olderThanMs?: number; probe?: () => Promise<CwdProbeResult>; into?: string } = {}): Promise<RepoReport> {
  const rep = await sweepWorktrees({
    repos: [f.repo],
    into: o.into,
    olderThanMs: o.olderThanMs ?? 0,
    apply: o.apply ?? false,
    cwdProbe: o.probe ?? noProbe,
    now: TEN_DAYS_LATER,
  });
  expect(rep.repos).toHaveLength(1);
  return rep.repos[0]!;
}

function verdict(rep: RepoReport, p: string): WorktreeVerdict {
  const v = rep.worktrees.find((w) => w.path === p);
  if (!v) throw new Error(`no verdict for ${p}; have ${rep.worktrees.map((w) => w.path).join(", ")}`);
  return v;
}
const codes = (v: WorktreeVerdict): string[] => v.reasons.map((r) => r.code);

function addMergedSubmoduleWorktree(f: Fixture): string {
  const subsrc = path.join(f.root, "subsrc");
  git(f.root, "init", "-b", "main", subsrc);
  fs.writeFileSync(path.join(subsrc, "s.txt"), "s\n");
  git(subsrc, "add", ".");
  git(subsrc, "commit", "-m", "s");
  const p = f.addWorktree("unit-a");
  git(p, "-c", "protocol.file.allow=always", "submodule", "add", subsrc, "vendor");
  git(p, "commit", "-m", "add submodule");
  git(f.repo, "merge", "--ff-only", "unit-a");
  git(f.repo, "push", "origin", "main");
  return p;
}

describe("z3 worktree sweep: what it removes", () => {
  it("removes a merged, clean, idle worktree on --apply, keeps its branch, and leaves the main checkout", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    f.commitAndMerge("unit-a");
    const rep = await sweep(f, { apply: true });
    expect(verdict(rep, p).outcome).toBe("removed");
    expect(fs.existsSync(p)).toBe(false);
    expect(git(f.repo, "branch", "--list", "unit-a")).toContain("unit-a");
    expect(fs.existsSync(path.join(f.repo, "README.md"))).toBe(true);
    expect(rep.worktrees.map((w) => w.path)).not.toContain(f.repo);
  });

  it("is a dry run by default: reports would-remove and deletes nothing", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const rep = await sweep(f);
    expect(verdict(rep, p).outcome).toBe("would-remove");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("removes a worktree whose only extra content is git-ignored (node_modules), and reports it", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    fs.mkdirSync(path.join(p, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(p, "node_modules", "x", "big.bin"), "x".repeat(4096));
    const rep = await sweep(f, { apply: true });
    expect(verdict(rep, p).outcome).toBe("removed");
    expect(fs.existsSync(p)).toBe(false);
  });

  it("removes a detached worktree sitting on a merged commit", async () => {
    const f = makeFixture();
    git(f.repo, "worktree", "add", "--detach", f.wt("det"));
    const rep = await sweep(f, { apply: true });
    expect(verdict(rep, f.wt("det")).outcome).toBe("removed");
    expect(verdict(rep, f.wt("det")).branch).toBeNull();
  });

  it("honours --into over origin/HEAD", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    git(p, "commit", "--allow-empty", "-m", "on a side ref");
    git(f.repo, "branch", "release", "unit-a");
    expect(codes(verdict(await sweep(f), p))).toContain("not-merged");
    expect(verdict(await sweep(f, { into: "release" }), p).outcome).toBe("would-remove");
  });

  it("lists one repository once even when named twice, and reports a non-repo without touching anything", async () => {
    const f = makeFixture();
    f.addWorktree("unit-a");
    const notRepo = path.join(f.root, "plain");
    fs.mkdirSync(notRepo);
    const rep = await sweepWorktrees({ repos: [f.repo, path.join(f.repo, "."), notRepo], olderThanMs: 0, apply: true, cwdProbe: noProbe, now: TEN_DAYS_LATER });
    expect(rep.repos.map((r) => r.repo)).toEqual([f.repo, notRepo]);
    expect(rep.repos[1]!.error).toMatch(/not a readable git repository/);
    expect(rep.repos[0]!.worktrees[0]!.outcome).toBe("removed");
  });
});

describe("z3 worktree sweep: what it must never remove", () => {
  it("keeps uncommitted tracked changes", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    fs.writeFileSync(path.join(p, "README.md"), "edited, not committed\n");
    const rep = await sweep(f, { apply: true });
    expect(codes(verdict(rep, p))).toEqual(["uncommitted-changes"]);
    expect(fs.readFileSync(path.join(p, "README.md"), "utf8")).toBe("edited, not committed\n");
  });

  it("keeps untracked files (the seat's unsaved new work)", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    fs.writeFileSync(path.join(p, "new-file.ts"), "precious\n");
    const rep = await sweep(f, { apply: true });
    expect(codes(verdict(rep, p))).toEqual(["uncommitted-changes"]);
    expect(fs.existsSync(path.join(p, "new-file.ts"))).toBe(true);
  });

  it("keeps a worktree with a commit that is not on the target ref", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    git(p, "commit", "--allow-empty", "-m", "unmerged work");
    const rep = await sweep(f, { apply: true });
    expect(codes(verdict(rep, p))).toEqual(["not-merged"]);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("keeps a branch merged only into a LOCAL main that was never pushed", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    fs.writeFileSync(path.join(p, "a.txt"), "a\n");
    git(p, "add", ".");
    git(p, "commit", "-m", "a");
    git(f.repo, "merge", "--ff-only", "unit-a"); // local main ahead of origin/main
    const rep = await sweep(f, { apply: true });
    expect(codes(verdict(rep, p))).toEqual(["not-merged"]);
  });

  it("keeps a squash-merged branch, because ancestry cannot prove it", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    fs.writeFileSync(path.join(p, "a.txt"), "a\n");
    git(p, "add", ".");
    git(p, "commit", "-m", "a");
    git(f.repo, "merge", "--squash", "unit-a");
    git(f.repo, "commit", "-m", "squash a");
    git(f.repo, "push", "origin", "main");
    const rep = await sweep(f, { apply: true });
    expect(codes(verdict(rep, p))).toEqual(["not-merged"]);
  });

  it("keeps a locked worktree", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    git(f.repo, "worktree", "lock", "--reason", "pinned by a seat", p);
    const rep = await sweep(f, { apply: true });
    const v = verdict(rep, p);
    expect(codes(v)).toContain("locked");
    expect(v.reasons[0]!.detail).toBe("pinned by a seat");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("keeps a worktree a running process is standing in, and one the caller is standing in", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const sub = path.join(p, "src");
    fs.mkdirSync(sub);
    const rep = await sweep(f, { apply: true, probe: async () => ({ cwds: [sub], unreadable: 0 }) });
    expect(codes(verdict(rep, p))).toEqual(["in-use"]);
    expect(fs.existsSync(p)).toBe(true);
    const prev = process.cwd();
    process.chdir(p);
    try {
      const rep2 = await sweep(f, { apply: true });
      expect(codes(verdict(rep2, p))).toEqual(["in-use"]);
    } finally {
      process.chdir(prev);
    }
  });

  it("keeps EVERYTHING when the in-use probe fails (unreadable is not 'nothing in use')", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const rep = await sweep(f, {
      apply: true,
      probe: async () => {
        throw new Error("lsof unavailable");
      },
    });
    const v = verdict(rep, p);
    expect(codes(v)).toEqual(["in-use-probe-failed"]);
    expect(v.reasons[0]!.detail).toContain("lsof unavailable");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("keeps a worktree touched within the age guard, and removes it once the guard has elapsed", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const real = Date.now();
    const young = await sweepWorktrees({ repos: [f.repo], olderThanMs: 24 * 3_600_000, apply: false, cwdProbe: noProbe, now: () => real });
    expect(codes(verdict(young.repos[0]!, p))).toEqual(["too-recent"]);
    const old = await sweepWorktrees({ repos: [f.repo], olderThanMs: 24 * 3_600_000, apply: false, cwdProbe: noProbe, now: TEN_DAYS_LATER });
    expect(verdict(old.repos[0]!, p).outcome).toBe("would-remove");
  });

  it("keeps a worktree mid-operation even though its tree is clean", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const gitDir = git(p, "rev-parse", "--path-format=absolute", "--git-dir");
    fs.writeFileSync(path.join(gitDir, "BISECT_LOG"), "");
    const rep = await sweep(f, { apply: true });
    expect(codes(verdict(rep, p))).toEqual(["operation-in-progress"]);
  });

  it("keeps a worktree that contains another worktree", async () => {
    const f = makeFixture();
    const outer = f.addWorktree("outer");
    git(f.repo, "worktree", "add", "-b", "inner", path.join(outer, "inner"));
    const rep = await sweep(f, { apply: true });
    expect(codes(verdict(rep, outer))).toContain("contains-another-worktree");
    // The outer checkout survives; the inner one is itself merged and clean, so it may go on its own.
    expect(fs.existsSync(outer)).toBe(true);
    expect(verdict(rep, path.join(outer, "inner")).outcome).toBe("removed");
  });

  it("keeps a worktree whose directory is gone (prunable) and leaves pruning to git", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    fs.rmSync(p, { recursive: true, force: true });
    const rep = await sweep(f, { apply: true });
    expect(codes(verdict(rep, p))).toEqual(["prunable-missing"]);
    expect(git(f.repo, "worktree", "list", "--porcelain")).toContain(p);
  });

  it("refuses the whole repo, removing nothing, when no merge target can be determined", async () => {
    const f = makeFixture({ originHead: false });
    const p = f.addWorktree("unit-a");
    const rep = await sweep(f, { apply: true });
    expect(rep.error).toMatch(/--into/);
    expect(rep.worktrees).toEqual([]);
    expect(fs.existsSync(p)).toBe(true);
    const bad = await sweep(f, { apply: true, into: "no-such-ref" });
    expect(bad.error).toMatch(/does not resolve/);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("when our checks pass but git itself refuses (submodule), reports remove-refused and leaves the directory", async () => {
    const f = makeFixture();
    const p = addMergedSubmoduleWorktree(f);
    const dry = await sweep(f);
    expect(verdict(dry, p).outcome).toBe("would-remove");
    const rep = await sweep(f, { apply: true });
    const v = verdict(rep, p);
    expect(v.outcome).toBe("kept");
    expect(codes(v)).toEqual(["remove-refused"]);
    expect(fs.existsSync(path.join(p, "vendor", "s.txt"))).toBe(true);
  });
});

describe("z3 worktree sweep: the CLI surface", () => {
  it("registers `rig worktree sweep` with a dry-run default and --apply", () => {
    const wt = createProgram().commands.find((c) => c.name() === "worktree");
    expect(wt).toBeDefined();
    const sweepCmd = wt!.commands.find((c) => c.name() === "sweep");
    expect(sweepCmd!.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--repo", "--into", "--older-than", "--apply", "--json"]));
  });

  async function run(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
    const p: Command = createProgram();
    p.exitOverride();
    const logs: string[] = [];
    const log = console.log;
    const errl = console.error;
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      await p.parseAsync(["node", "rig", "worktree", "sweep", ...args]);
      return { out: logs.join("\n"), exitCode: process.exitCode as number | undefined };
    } finally {
      console.log = log;
      console.error = errl;
      process.exitCode = prevExit;
    }
  }

  it("dry run reports and keeps; --apply removes; --json carries reasons", async () => {
    const f = makeFixture();
    const good = f.addWorktree("good");
    f.commitAndMerge("good");
    const dirty = f.addWorktree("dirty");
    fs.writeFileSync(path.join(dirty, "x"), "x\n");
    const dry = await run(["--repo", f.repo, "--older-than", "0s", "--json"]);
    const parsed = JSON.parse(dry.out) as { apply: boolean; repos: RepoReport[] };
    expect(parsed.apply).toBe(false);
    expect(verdict(parsed.repos[0]!, good).outcome).toBe("would-remove");
    expect(codes(verdict(parsed.repos[0]!, dirty))).toEqual(["uncommitted-changes"]);
    expect(fs.existsSync(good)).toBe(true);
    const text = await run(["--repo", f.repo, "--older-than", "0s"]);
    expect(text.out).toContain("DRY RUN");
    expect(text.out).toContain("Re-run with --apply");
    const applied = await run(["--repo", f.repo, "--older-than", "0s", "--apply"]);
    expect(applied.out).toContain("removed 1, kept 1");
    expect(fs.existsSync(good)).toBe(false);
    expect(fs.existsSync(dirty)).toBe(true);
  });

  it("rejects a malformed --older-than without sweeping", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const r = await run(["--repo", f.repo, "--older-than", "soon", "--apply"]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toMatch(/Invalid duration/);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("the default age guard (24h) protects a fresh worktree", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const r = await run(["--repo", f.repo, "--apply"]);
    expect(r.out).toContain("too-recent");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("exits non-zero when git refuses a removal the sweep attempted", async () => {
    const f = makeFixture();
    const p = addMergedSubmoduleWorktree(f);
    const r = await run(["--repo", f.repo, "--older-than", "0s", "--apply"]);
    expect(r.out).toContain("remove-refused");
    expect(r.exitCode).toBe(1);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("exits non-zero when a repo could not be assessed", async () => {
    const f = makeFixture({ originHead: false });
    f.addWorktree("unit-a");
    const r = await run(["--repo", f.repo]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("SKIPPED");
  });
});

describe("z3 worktree sweep: parsing helpers", () => {
  it("parseDuration", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration("0s")).toBe(0);
    expect(() => parseDuration("24")).toThrow(/Invalid duration/);
  });

  it("parseWorktreeList reads branch, detached, locked and prunable records", () => {
    const text = [
      "worktree /r",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /r-a",
      "HEAD bbb",
      "branch refs/heads/feat/x",
      "locked because",
      "",
      "worktree /r-b",
      "HEAD ccc",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    const l = parseWorktreeList(text);
    expect(l.map((w) => [w.path, w.branch, w.locked, w.prunable !== null])).toEqual([
      ["/r", "main", null, false],
      ["/r-a", "feat/x", "because", false],
      ["/r-b", null, null, true],
    ]);
  });

  it("renderSweepReport states what was kept and why", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    fs.writeFileSync(path.join(p, "n"), "n\n");
    const text = renderSweepReport({ apply: false, olderThanMs: 0, unreadableProcesses: 3, repos: [await sweep(f)] });
    expect(text).toContain("KEEP");
    expect(text).toContain("uncommitted-changes");
    expect(text).toContain("3 process working directories were unreadable");
  });
});
