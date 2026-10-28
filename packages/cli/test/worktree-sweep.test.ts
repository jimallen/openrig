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
import { defaultCwdProbe, lsofCwdProbe, newestActivityMs, parseDuration, parseWorktreeList, renderSweepReport, sweepWorktrees, type CwdProbeResult, type LsofRun, type RepoReport, type WorktreeVerdict } from "../src/worktree-sweep.js";

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

/** Repo-wide ignore rules without a commit (info/exclude applies to every linked worktree). */
function exclude(f: Fixture, ...patterns: string[]): void {
  const file = path.join(f.repo, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true }); // an empty GIT_TEMPLATE_DIR (Sparky) creates no info/
  fs.appendFileSync(file, patterns.join("\n") + "\n");
}

/** Commit a tracked file in the worktree and fast-forward origin/main over it, so the worktree stays merged and clean. */
function commitTracked(f: Fixture, name: string, rel: string, content: string): void {
  const file = path.join(f.wt(name), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  git(f.wt(name), "add", rel);
  git(f.wt(name), "commit", "-m", `add ${rel}`);
  git(f.repo, "merge", "--ff-only", name);
  git(f.repo, "push", "origin", "main");
}

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

  it("still removes ignored dependency trees (node_modules beside a package.json) even when a package ships a .pem/.env fixture", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    commitTracked(f, "unit-a", "package.json", "{}\n");
    exclude(f, "node_modules/");
    fs.mkdirSync(path.join(p, "node_modules", "pkg", "node_modules", "deep"), { recursive: true });
    fs.writeFileSync(path.join(p, "node_modules", "pkg", "fixture.pem"), "x\n");
    fs.writeFileSync(path.join(p, "node_modules", "pkg", ".env"), "x\n");
    fs.writeFileSync(path.join(p, "node_modules", "pkg", "node_modules", "deep", "k.key"), "x\n");
    expect(verdict(await sweep(f), p).outcome).toBe("would-remove");
  });

  it("removes a worktree whose ignored files are ordinary build output (positive control for the secret scan)", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    exclude(f, "build/");
    fs.mkdirSync(path.join(p, "build", "out"), { recursive: true });
    fs.writeFileSync(path.join(p, "build", "out", "main.js"), "x\n");
    expect(verdict(await sweep(f), p).outcome).toBe("would-remove");
  });

  it("with --repo naming a removable LINKED worktree, still removes every worktree (runs from the main checkout)", async () => {
    const f = makeFixture();
    const a = f.addWorktree("a");
    const b = f.addWorktree("b");
    const rep = await sweepWorktrees({ repos: [a], olderThanMs: 0, apply: true, cwdProbe: noProbe, now: TEN_DAYS_LATER });
    expect(rep.repos[0]!.worktrees.map((w) => [w.path, w.outcome]).sort()).toEqual([[a, "removed"], [b, "removed"]]);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(fs.existsSync(f.repo)).toBe(true);
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

  it.each([
    [".env"],
    [".env.local"],
    ["certs/server.pem"],
    ["deploy.key"],
    [".env.example"],
    [".env.production.dist"],
    [".envrc"],
    ["prod.env"],
    ["id_rsa"],
    ["id_ed25519.pub"],
    [".npmrc"],
    [".netrc"],
    ["credentials.json"],
    ["secrets/aws.json"],
    [".ENV"],
    ["ID_RSA"],
    ["Server.PEM"],
    ["Deploy.Key"],
    ["cert.p12"],
    ["CERT.PFX"],
    ["store.jks"],
    [".pgpass"],
    ["config/secrets"],
    ["Token.txt"],
    ["tokens.json"],
    ["SECRETS/token.txt"],
    ["config/node_modules/real.key"],
  ])(
    "keeps a worktree holding the ignored secret-looking file %s, and names it",
    async (rel) => {
      const f = makeFixture();
      const p = f.addWorktree("unit-a");
      exclude(f, "*");
      fs.mkdirSync(path.dirname(path.join(p, rel)), { recursive: true });
      fs.writeFileSync(path.join(p, rel), "SECRET=1\n");
      const rep = await sweep(f, { apply: true });
      const v = verdict(rep, p);
      expect(codes(v)).toEqual(["secret-looking-ignored-file"]);
      expect(v.reasons[0]!.detail).toContain(rel);
      expect(fs.readFileSync(path.join(p, rel), "utf8")).toBe("SECRET=1\n");
    },
  );

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

  it.each([["assume-unchanged", "--assume-unchanged"], ["skip-worktree", "--skip-worktree"]])(
    "keeps a worktree whose edit is hidden by %s (invisible to git status and to git's own remove)",
    async (_label, flag) => {
      const f = makeFixture();
      const p = f.addWorktree("unit-a");
      git(p, "update-index", flag, "README.md");
      fs.writeFileSync(path.join(p, "README.md"), "hidden local edit\n");
      expect(git(p, "status", "--porcelain")).toBe(""); // the premise: status cannot see it
      const rep = await sweep(f, { apply: true });
      const v = verdict(rep, p);
      expect(codes(v)).toEqual(["hidden-index-flags"]);
      expect(v.reasons[0]!.detail).toContain("README.md");
      expect(fs.readFileSync(path.join(p, "README.md"), "utf8")).toBe("hidden local edit\n");
    },
  );

  it("keeps a worktree holding a nested git repo under an ignored directory (its .env is invisible to ls-files)", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    exclude(f, "vendor/");
    const inner = path.join(p, "vendor", "inner");
    fs.mkdirSync(inner, { recursive: true });
    git(inner, "init", "-b", "main");
    fs.writeFileSync(path.join(inner, ".env"), "SECRET=1\n");
    const rep = await sweep(f, { apply: true });
    const v = verdict(rep, p);
    expect(codes(v)).toEqual(["nested-repo-in-ignored-path"]);
    expect(v.reasons[0]!.detail).toContain("vendor/inner/.git");
    expect(fs.readFileSync(path.join(inner, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("does not exempt a node_modules directory that is not beside a package.json", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    exclude(f, "node_modules/");
    fs.mkdirSync(path.join(p, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(p, "node_modules", "pkg", "k.pem"), "x\n");
    expect(codes(verdict(await sweep(f), p))).toEqual(["secret-looking-ignored-file"]);
  });

  it.each([
    ["rebase-merge", "dir"],
    ["rebase-apply", "dir"],
    ["sequencer", "dir"],
    ["MERGE_HEAD", "sha"],
    ["CHERRY_PICK_HEAD", "sha"],
    ["REVERT_HEAD", "sha"],
    ["BISECT_LOG", "file"],
  ])("keeps a worktree with %s present in its git dir", async (marker, kind) => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const gitDir = git(p, "rev-parse", "--path-format=absolute", "--git-dir");
    const target = path.join(gitDir, marker);
    if (kind === "dir") fs.mkdirSync(target);
    else fs.writeFileSync(target, kind === "sha" ? git(p, "rev-parse", "HEAD") + "\n" : "");
    const rep = await sweep(f, { apply: true });
    const v = verdict(rep, p);
    expect(v.outcome).toBe("kept");
    expect(v.reasons.filter((r) => r.code === "operation-in-progress").map((r) => r.detail)).toContain(`${marker} present`);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("keeps a worktree whose index is corrupt: status, ignored-file scan and hidden-flag scan all fail closed", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const gitDir = git(p, "rev-parse", "--path-format=absolute", "--git-dir");
    fs.writeFileSync(path.join(gitDir, "index"), "this is not an index\n");
    const rep = await sweep(f, { apply: true });
    const v = verdict(rep, p);
    expect(v.outcome).toBe("kept");
    expect(codes(v)).toEqual(expect.arrayContaining(["status-unreadable", "ignored-files-unreadable", "index-flags-unreadable"]));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("keeps a worktree whose HEAD names a commit that does not exist (head-unreadable)", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const gitDir = git(p, "rev-parse", "--path-format=absolute", "--git-dir");
    fs.writeFileSync(path.join(gitDir, "HEAD"), "1234567890123456789012345678901234567890\n");
    const rep = await sweep(f, { apply: true });
    const v = verdict(rep, p);
    expect(v.outcome).toBe("kept");
    expect(codes(v)).toContain("head-unreadable");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("keeps a worktree when the ancestry check itself errors (a commit between HEAD and the target is missing)", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a"); // HEAD = seed commit A
    // main gains B then C (pushed); the worktree stays on A. Deleting loose object B breaks the walk C -> B -> A.
    fs.writeFileSync(path.join(f.repo, "b.txt"), "b\n");
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-m", "B");
    const b = git(f.repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(f.repo, "c.txt"), "c\n");
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-m", "C");
    git(f.repo, "push", "origin", "main");
    const obj = path.join(f.repo, ".git", "objects", b.slice(0, 2), b.slice(2));
    expect(fs.existsSync(obj)).toBe(true); // premise: loose, so deleting it really breaks the chain
    fs.rmSync(obj);
    const rep = await sweep(f, { apply: true });
    const v = verdict(rep, p);
    expect(v.outcome).toBe("kept");
    expect(codes(v)).toContain("merge-check-failed");
    expect(codes(v)).not.toContain("not-merged");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("keeps a worktree whose git-dir timestamps cannot be read (age-unreadable)", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const rep = await sweepWorktrees({
      repos: [f.repo],
      olderThanMs: 24 * 3_600_000,
      apply: true,
      cwdProbe: noProbe,
      now: TEN_DAYS_LATER,
      activity: async () => ({ ms: null, error: "stat refused" }),
    });
    const v = verdict(rep.repos[0]!, p);
    expect(codes(v)).toEqual(["age-unreadable"]);
    expect(v.reasons[0]!.detail).toBe("stat refused");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("newestActivityMs: an empty git dir is an error, a readable one is a time (and a non-ENOENT stat error is an error)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "z3-act-"));
    roots.push(dir);
    expect((await newestActivityMs(dir)).ms).toBeNull();
    expect((await newestActivityMs(dir)).error).toMatch(/no HEAD/);
    fs.writeFileSync(path.join(dir, "HEAD"), "x");
    expect((await newestActivityMs(dir)).ms).toBeGreaterThan(0);
    const file = path.join(dir, "afile");
    fs.writeFileSync(file, "x");
    const bad = await newestActivityMs(file); // HEAD under a regular file: ENOTDIR, not ENOENT
    expect(bad.ms).toBeNull();
    expect(bad.error).toMatch(/ENOTDIR/); // the real stat error, not the generic "no timestamps found" text
    expect(bad.error).not.toMatch(/no HEAD/);
  });

  it("keeps a worktree when git status prints errors (mode-000 directory holding an untracked file)", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const locked = path.join(p, "hidden");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "unsaved.ts"), "precious\n");
    fs.chmodSync(locked, 0o000);
    try {
      const rep = await sweep(f, { apply: true });
      const v = verdict(rep, p);
      expect(v.outcome).toBe("kept");
      expect(codes(v)).toContain("status-unreadable");
      expect(v.reasons.find((r) => r.code === "status-unreadable")!.detail).toMatch(/hidden/);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
    expect(fs.readFileSync(path.join(locked, "unsaved.ts"), "utf8")).toBe("precious\n");
  });

  it("fails closed when the ignored-path walk reaches its entry cap, and not before", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    exclude(f, "build/");
    fs.mkdirSync(path.join(p, "build"));
    fs.writeFileSync(path.join(p, "build", "one"), "1\n");
    fs.writeFileSync(path.join(p, "build", "two"), "2\n");
    const at = async (cap: number) => {
      const r = await sweepWorktrees({ repos: [f.repo], olderThanMs: 0, apply: false, cwdProbe: noProbe, now: TEN_DAYS_LATER, walkEntryCap: cap });
      return verdict(r.repos[0]!, p);
    };
    expect((await at(2)).outcome).toBe("would-remove"); // exactly the cap is allowed
    const over = await at(1);
    expect(codes(over)).toEqual(["ignored-files-unreadable"]);
    expect(over.reasons[0]!.detail).toContain("more than 1 entries");
  });

  it("keeps a worktree when walking its ignored directories fails", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    exclude(f, "build/");
    const locked = path.join(p, "build", "sub");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "f"), "x\n");
    fs.chmodSync(locked, 0o000);
    try {
      const rep = await sweep(f, { apply: true });
      const v = verdict(rep, p);
      expect(v.outcome).toBe("kept");
      expect(codes(v)).toContain("ignored-files-unreadable");
    } finally {
      fs.chmodSync(locked, 0o755);
    }
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

// a4 (z3 review gap): the macOS in-use path (`lsof -d cwd -Fn`) was never exercised. The runner is injected, so these
// rows run on any host and never read the real process table. The consequence under test is data loss: a probe that
// reads "lsof said nothing useful" as "nobody is standing in this worktree" would remove a worktree someone is using.
describe("z3 worktree sweep: the macOS lsof in-use probe (injected runner)", () => {
  const DARWIN = "darwin" as const;
  // lsof -d cwd -Fn prints, per process: p<pid>, f<fd> (always "fcwd" here), n<path>.
  const lsofOut = (...cwds: string[]): string => cwds.map((c, i) => `p${100 + i}\nfcwd\nn${c}\n`).join("");
  const probeWith = (run: LsofRun) => (): Promise<CwdProbeResult> => defaultCwdProbe({ platform: DARWIN, lsof: async () => run });
  const exit = (code: unknown, message: string) => ({ code, message });

  it("a process whose cwd is inside the worktree keeps it (in-use), even beside unrelated processes", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const sub = path.join(fs.realpathSync(p), "src");
    fs.mkdirSync(sub);
    const rep = await sweep(f, { apply: true, probe: probeWith({ stdout: lsofOut("/", "/Users/someone", sub), error: null }) });
    expect(codes(verdict(rep, p))).toEqual(["in-use"]);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("no process in the worktree: a merged clean one is removed; a sibling path with the same prefix does not count", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const lookalike = `${fs.realpathSync(p)}-other`;
    const rep = await sweep(f, { apply: true, probe: probeWith({ stdout: lsofOut("/", "/Users/someone", lookalike), error: null }) });
    expect(verdict(rep, p).outcome).toBe("removed");
    expect(fs.existsSync(p)).toBe(false);
  });

  it("lsof exit 1 (some processes not inspectable) with the rest printed is a usable listing, both ways", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const q = f.addWorktree("unit-b");
    const stdout = lsofOut("/", fs.realpathSync(q));
    const rep = await sweep(f, { probe: probeWith({ stdout, error: exit(1, "Command failed: lsof -d cwd -Fn") }) });
    expect(verdict(rep, p).outcome).toBe("would-remove");
    expect(codes(verdict(rep, q))).toEqual(["in-use"]);
  });

  it("lsof missing (ENOENT) keeps everything with the probe-failed reason", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const rep = await sweep(f, { apply: true, probe: probeWith({ stdout: "", error: exit("ENOENT", "spawn lsof ENOENT") }) });
    const v = verdict(rep, p);
    expect(codes(v)).toEqual(["in-use-probe-failed"]);
    expect(v.reasons[0]!.detail).toContain("lsof unavailable");
    expect(fs.existsSync(p)).toBe(true);
  });

  it.each<[string, LsofRun]>([
    ["lsof killed by a signal", { stdout: "", error: exit(null, "Command failed: lsof (SIGKILL)") }],
    ["exit 1 with nothing printed", { stdout: "", error: exit(1, "Command failed: lsof -d cwd -Fn") }],
    ["exit status above 1", { stdout: "", error: exit(2, "Command failed: lsof") }],
    ["success with empty output", { stdout: "", error: null }],
    ["output that is not lsof -F records", { stdout: "lsof: WARNING: can't stat() fuse file system\n", error: null }],
    ["permission-denied spawn (EACCES)", { stdout: "", error: exit("EACCES", "spawn lsof EACCES") }],
  ])("an unreadable result keeps everything: %s", async (_label, run) => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    const rep = await sweep(f, { apply: true, probe: probeWith(run) });
    expect(codes(verdict(rep, p))).toEqual(["in-use-probe-failed"]);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("lsof output cut off at the buffer limit is not a listing: the partial output omits the busy worktree, so it must keep", async () => {
    const f = makeFixture();
    const p = f.addWorktree("unit-a");
    // The truncated stdout holds only other processes; the process standing in unit-a came after the cut.
    const rep = await sweep(f, {
      apply: true,
      probe: probeWith({ stdout: lsofOut("/", "/Users/someone"), error: exit("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "stdout maxBuffer length exceeded") }),
    });
    expect(codes(verdict(rep, p))).toEqual(["in-use-probe-failed"]);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("the probe reports no unreadable-process count on macOS (lsof sees only the invoking user's processes)", async () => {
    await expect(lsofCwdProbe(async () => ({ stdout: lsofOut("/a", "/b"), error: null }))).resolves.toEqual({ cwds: ["/a", "/b"], unreadable: 0 });
  });

  // The real runner (`runLsof`: execFile glue and its error mapping) driven through a stub `lsof` found on PATH, so the
  // error mapping and the buffer limit are executed, not just the parser behind them. The real lsof is never run.
  describe("the real runner, against a stub lsof on PATH", () => {
    const savedPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = savedPath;
    });
    function stubLsof(script: string): void {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a4-stub-lsof-")));
      roots.push(dir);
      fs.writeFileSync(path.join(dir, "lsof"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      process.env.PATH = dir;
    }
    const RECORDS = "printf 'p100\\nfcwd\\nn/stub/one\\np101\\nfcwd\\nn/stub/two\\n'";

    it("a clean run is a usable listing", async () => {
      stubLsof(RECORDS);
      await expect(defaultCwdProbe({ platform: DARWIN })).resolves.toEqual({ cwds: ["/stub/one", "/stub/two"], unreadable: 0 });
    });

    it("exit 1 with the rest printed is a usable listing (lsof could not inspect some processes)", async () => {
      stubLsof(`${RECORDS}\nexit 1`);
      await expect(defaultCwdProbe({ platform: DARWIN })).resolves.toEqual({ cwds: ["/stub/one", "/stub/two"], unreadable: 0 });
    });

    it("any other exit status fails the probe even though records were printed", async () => {
      stubLsof(`${RECORDS}\nexit 2`);
      await expect(defaultCwdProbe({ platform: DARWIN })).rejects.toThrow(/lsof failed \(2\)/);
    });

    it("output cut off at the buffer limit fails the probe rather than passing as a complete listing", async () => {
      stubLsof(RECORDS);
      await expect(defaultCwdProbe({ platform: DARWIN, lsofMaxBuffer: 16 })).rejects.toThrow(/lsof failed \(ERR_CHILD_PROCESS_STDIO_MAXBUFFER\)/);
    });

    it("lsof not on PATH fails the probe as unavailable", async () => {
      const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a4-no-lsof-")));
      roots.push(empty);
      process.env.PATH = empty;
      await expect(defaultCwdProbe({ platform: DARWIN })).rejects.toThrow(/lsof unavailable/);
    });
  });

  it("the platform decides the path: darwin uses the injected lsof runner, never /proc", async () => {
    let calls = 0;
    await defaultCwdProbe({ platform: DARWIN, lsof: async () => { calls += 1; return { stdout: lsofOut("/x"), error: null }; } });
    expect(calls).toBe(1);
  });
});
