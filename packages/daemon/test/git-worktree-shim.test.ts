import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkTemp } from "./helpers/temp-roots.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { ensureGitWorktreeShim, refreshGitWorktreeShim, shimDir, withWorktreeShimPath } from "../src/domain/git-worktree-shim.js";
import { ensureCodexSeatHome } from "../src/domain/codex-seat-home.js";
import { nodeShimFiles } from "../src/adapters/node-shim-files.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type Database from "better-sqlite3";
import { vi } from "vitest";

let tmp: string;

const SHIM_MARKER = "openrig git worktree placement shim";

/** The first git on the test process's PATH that is a real git and not any openrig shim (a seat's own live
 * shim is on this PATH too), so shim rows never depend on the host's installed shim. */
function realGitDir(): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "git");
    if (!existsSync(candidate)) continue;
    if (readFileSync(candidate).includes(SHIM_MARKER)) continue;
    return dir;
  }
  throw new Error("no real git on PATH");
}

/** A directory holding only symlinks to the named host tools, so a row can build a PATH with no git on it. */
async function toolsDir(...tools: string[]): Promise<string> {
  const dir = path.join(tmp, "tools");
  await fs.mkdir(dir, { recursive: true });
  for (const tool of tools) {
    const found = spawnSync("bash", ["-c", `type -P ${tool}`]).stdout.toString().trim();
    if (!found) throw new Error(`no ${tool} on PATH`);
    await fs.symlink(found, path.join(dir, tool));
  }
  return dir;
}

/** A stand-in git that only says it ran: 'PREF <args>'. rev-parse --show-toplevel answers the cwd, so the
 * worktree branch of the shim sees a repo. */
async function prefGitDir(): Promise<string> {
  const dir = path.join(tmp, "pref");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "git"),
    '#!/bin/sh\nif [ "$1" = rev-parse ]; then pwd; exit 0; fi\necho "PREF $*"\n',
    { mode: 0o755 },
  );
  return dir;
}

/** Run 'git <args>' through PATH lookup, as a seat does, under real bash via the shim's shebang. A loop is
 * cut off by the timeout and shows as a signal. */
function runGit(args: string[], pathDirs: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync("git", args, {
    cwd,
    env: { ...process.env, PATH: pathDirs.join(path.delimiter), ...extraEnv },
    timeout: 5000,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

/** The shim's one refusal line for a worktree path outside <toplevel>/.rig-worktrees (workspaces-o9o.102). Plain paths
 * only (letters, digits, '/', '.', '-', '_'), which bash's %q prints unchanged; a row with other bytes uses REFUSAL. */
function refusal(target: string, toplevel: string): string {
  if (!/^[A-Za-z0-9/._-]+$/.test(target + toplevel)) throw new Error(`refusal(): plain paths only: ${JSON.stringify(target)} ${JSON.stringify(toplevel)}`);
  return `openrig git shim: refusing worktree path ${target}: seat worktrees go in ${toplevel}/.rig-worktrees/<name>\n`;
}
const REFUSAL = /^openrig git shim: refusing worktree path [^\n]*: seat worktrees go in [^\n]*\/\.rig-worktrees\/<name>\n$/;

function dockerImagePresent(image: string): boolean {
  const r = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10000 });
  return r.status === 0;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shim-test-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("git-worktree-shim", () => {
  it("writes the shim once, content-addressed, and the file is executable", async () => {
    const dir = await ensureGitWorktreeShim(tmp, nodeShimFiles);
    expect(dir).toBe(path.join(tmp, "rig-bin"));
    const body = await fs.readFile(path.join(dir, "git"), "utf8");
    expect(body).toContain("worktree add");
    expect((await fs.lstat(path.join(dir, "git"))).mode & 0o100).toBeTruthy();
    // second call is a no-op
    await ensureGitWorktreeShim(tmp, nodeShimFiles);
  });

  // workspaces-o9o.50: one refresh for daemon start and seat launch; never through a symlink, atomic, says what it did.
  describe("refresh: never through a symlink, atomic, reports what it did", () => {
    const STALE = "#!/usr/bin/env bash\nexec /usr/bin/git \"$@\"\n";

    it("launch refuses a symlinked rig-bin: throws, and the link's target is not written", async () => {
      const elsewhere = path.join(tmp, "elsewhere");
      await fs.mkdir(elsewhere);
      await fs.writeFile(path.join(elsewhere, "git"), STALE, { mode: 0o755 });
      await fs.symlink(elsewhere, path.join(tmp, "rig-bin"));
      await expect(ensureGitWorktreeShim(tmp, nodeShimFiles)).rejects.toThrow(/refused .*rig-bin is a symlink/);
      expect(await fs.readFile(path.join(elsewhere, "git"), "utf8")).toBe(STALE);
      expect(await fs.readdir(elsewhere)).toEqual(["git"]);
    });

    it("launch refuses a symlinked rig-bin/git: throws, the target is not written, the link stays", async () => {
      const target = path.join(tmp, "real-git");
      await fs.writeFile(target, STALE, { mode: 0o755 });
      await fs.mkdir(path.join(tmp, "rig-bin"));
      await fs.symlink(target, path.join(tmp, "rig-bin", "git"));
      await expect(ensureGitWorktreeShim(tmp, nodeShimFiles)).rejects.toThrow(/refused .*rig-bin\/git is a symlink/);
      expect(await fs.readFile(target, "utf8")).toBe(STALE);
      expect(await fs.readlink(path.join(tmp, "rig-bin", "git"))).toBe(target);
    });

    it("rig-bin that is a file, or git that is a directory, is refused, not replaced", async () => {
      await fs.writeFile(path.join(tmp, "rig-bin"), "x");
      expect(await refreshGitWorktreeShim(tmp, nodeShimFiles)).toEqual({ kind: "refused", path: path.join(tmp, "rig-bin", "git"), reason: `${path.join(tmp, "rig-bin")} is not a directory` });
      await fs.rm(path.join(tmp, "rig-bin"));
      await fs.mkdir(path.join(tmp, "rig-bin", "git"), { recursive: true });
      expect(await refreshGitWorktreeShim(tmp, nodeShimFiles)).toEqual({ kind: "refused", path: path.join(tmp, "rig-bin", "git"), reason: `${path.join(tmp, "rig-bin", "git")} is not a regular file` });
      expect((await fs.lstat(path.join(tmp, "rig-bin", "git"))).isDirectory()).toBe(true);
    });

    it("a failed write leaves the old shim whole and no temp behind", async () => {
      const dir = path.join(tmp, "rig-bin");
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "git"), STALE, { mode: 0o755 });
      await fs.chmod(dir, 0o555);
      try {
        await expect(refreshGitWorktreeShim(tmp, nodeShimFiles)).rejects.toThrow(/EACCES/);
      } finally {
        await fs.chmod(dir, 0o755);
      }
      expect(await fs.readFile(path.join(dir, "git"), "utf8")).toBe(STALE);
      expect(await fs.readdir(dir)).toEqual(["git"]);
    });

    it("a rename that fails after the temp exists leaves the old shim whole and removes the temp", async () => {
      const dir = path.join(tmp, "rig-bin");
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "git"), STALE, { mode: 0o755 });
      const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("EXDEV: simulated"), { code: "EXDEV" }));
      try {
        await expect(refreshGitWorktreeShim(tmp, nodeShimFiles)).rejects.toThrow(/EXDEV: simulated/);
        expect(rename).toHaveBeenCalledOnce();
        expect(path.dirname(String(rename.mock.calls[0]![0]))).toBe(dir);
      } finally {
        rename.mockRestore();
      }
      expect(await fs.readFile(path.join(dir, "git"), "utf8")).toBe(STALE);
      expect(await fs.readdir(dir)).toEqual(["git"]);
    });

    it("under a 077 umask the shim is still written 0755 (the mode is set, not left to the umask)", async () => {
      const old = process.umask(0o077);
      try {
        await refreshGitWorktreeShim(tmp, nodeShimFiles);
      } finally {
        process.umask(old);
      }
      expect((await fs.stat(path.join(tmp, "rig-bin", "git"))).mode & 0o777).toBe(0o755);
    });

    it("created, then unchanged, then replaced, then mode-fixed: each says what it did, with hashes", async () => {
      const file = path.join(tmp, "rig-bin", "git");
      const created = await refreshGitWorktreeShim(tmp, nodeShimFiles);
      expect(created).toMatchObject({ kind: "created", path: file });
      const want = (created as { sha256: string }).sha256;
      expect(want).toMatch(/^[0-9a-f]{64}$/);
      expect(await refreshGitWorktreeShim(tmp, nodeShimFiles)).toEqual({ kind: "unchanged", path: file, sha256: want });
      await fs.writeFile(file, STALE);
      const replaced = await refreshGitWorktreeShim(tmp, nodeShimFiles);
      expect(replaced).toMatchObject({ kind: "replaced", path: file, toSha256: want });
      expect((replaced as { fromSha256: string }).fromSha256).not.toBe(want);
      await fs.chmod(file, 0o700);
      expect(await refreshGitWorktreeShim(tmp, nodeShimFiles)).toEqual({ kind: "mode-fixed", path: file, fromMode: 0o700, toMode: 0o755 });
      expect((await fs.stat(file)).mode & 0o777).toBe(0o755);
      expect(await fs.readdir(path.join(tmp, "rig-bin"))).toEqual(["git"]);
    });
  });

  it("refuses an out-of-repo 'git worktree add' (nothing created anywhere), keeps normal add", async () => {
    // real repo under tmp
    const repo = path.join(tmp, "repo");
    await fs.mkdir(repo);
    const init = spawnSync("git", ["init", "-q", repo], { stdio: "ignore" });
    expect(init.status).toBe(0);
    spawnSync("git", ["-C", repo, "config", "user.name", "test"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "config", "user.email", "t@e"], { stdio: "ignore" });
    await fs.writeFile(path.join(repo, "f.txt"), "x");
    spawnSync("git", ["-C", repo, "add", "f.txt"], { stdio: "ignore" });
    spawnSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" });
    // tests run with an isolated HOME, so no global excludes: ignore the scratch dir here
    await fs.mkdir(path.join(repo, ".git", "info"), { recursive: true }); // the git template may have no info/ (workspaces-o9o.70)
    await fs.appendFile(path.join(repo, ".git", "info", "exclude"), ".rig-worktrees/\n");

    const shimDirPath = await ensureGitWorktreeShim(tmp, nodeShimFiles);
    const pathDirs = [shimDirPath, realGitDir(), "/usr/bin", "/bin"];

    // out-of-place target => refused: exit 128, one line, nothing at the path asked for or in .rig-worktrees
    const outside = path.join(tmp, "outside-wt");
    const r1 = runGit(["worktree", "add", outside], pathDirs, repo);
    expect(r1.status).toBe(128);
    expect(r1.stderr).toBe(refusal(outside, await fs.realpath(repo)));
    expect(existsSync(outside), "the out-of-place target is not created").toBe(false);
    expect(existsSync(path.join(repo, ".rig-worktrees", "outside-wt")), "nor moved into .rig-worktrees").toBe(false);

    // in-place target => left alone
    const inside = path.join(repo, ".rig-worktrees", "explicit-wt");
    const r2 = runGit(["worktree", "add", inside], pathDirs, repo);
    expect(r2.status).toBe(0);
    expect((await fs.lstat(inside)).isDirectory()).toBe(true);
    expect(r2.stderr).not.toMatch(/invalid option|unbound variable|openrig shim/);

    // ordinary git verbs passthrough
    const r3 = runGit(["-C", repo, "status", "--porcelain"], pathDirs, tmp);
    expect(r3.status).toBe(0);
    // clean repo → empty output is correct; the point is the shim didn't eat the verb
    expect(r3.stdout.trim()).toBe("");
    expect(r3.stderr, "an ordinary git call prints nothing from the shim").toBe("");
  });

  // workspaces-o9o.102: a worktree asked for outside <repo>/.rig-worktrees is refused, never moved. The shim used to
  // create it inside .rig-worktrees and exit 0, so a caller that went on to use the path it asked for failed later,
  // after its own side effects: openrig-deploy pushed, then found no build tree (o9o.101), and test fixtures failed
  // far from the cause (o9o.77). Measured at release-6 8edc194e7: exit 0, the tree in .rig-worktrees/<sha>, nothing
  // printed.
  it("openrig-deploy's call, 'git -c core.hooksPath=/dev/null -C <repo> worktree add --detach <outside> <sha>': refused, exit 128, one line, nothing created", async () => {
    const repo = path.join(tmp, "fork");
    await fs.mkdir(repo);
    const git = path.join(realGitDir(), "git");
    expect(spawnSync(git, ["init", "-q", repo]).status).toBe(0);
    expect(spawnSync(git, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
    const sha = spawnSync(git, ["-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
    const realRepoDir = await fs.realpath(repo);
    const build = path.join(tmp, "rsi", "build", sha);
    const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
    const r = runGit(["-c", "core.hooksPath=/dev/null", "-C", repo, "worktree", "add", "--detach", build, sha], [shim, realGitDir(), "/usr/bin", "/bin"], tmp);
    expect(r.status, r.stderr).toBe(128);
    expect(r.stderr).toBe(
      `openrig git shim: refusing worktree path ${build}: seat worktrees go in ${realRepoDir}/.rig-worktrees/<name>\n`,
    );
    expect(existsSync(build), "nothing at the path asked for").toBe(false);
    expect(existsSync(path.join(realRepoDir, ".rig-worktrees")), "nothing moved into .rig-worktrees either").toBe(false);
    const list = spawnSync(git, ["-C", repo, "worktree", "list", "--porcelain"]).stdout.toString();
    expect(list.match(/^worktree /gm)?.length, list).toBe(1);
  });

  // workspaces-o9o.102, verify-sec review of 28dacd923 (FAIL 1/3). Three ways an outside worktree still got made, each
  // measured on real git: (1) git takes a unique prefix of a long option ('--det' is --detach), the shim did not know the
  // word, and an unknown word went through unchecked; (2) a relative path was resolved from $(pwd -P), which drops a
  // trailing newline of the repo's name, so an inside path was refused; (3) a dangling symlink under .rig-worktrees was
  // taken by name, as if it did not exist, so a path through it read as inside and git ran.
  describe("verify-sec review of 28dacd923: fail closed on a word the shim cannot classify, newline-safe cwd, no symlink portal", () => {
    const realGits = () => [...new Set([realGitDir(), ...(existsSync("/usr/bin/git") ? ["/usr/bin"] : [])])];
    async function repoAt(dir: string, gitDir: string): Promise<string> {
      const git = path.join(gitDir, "git");
      await fs.mkdir(dir, { recursive: true });
      expect(spawnSync(git, ["init", "-q", dir]).status).toBe(0);
      expect(spawnSync(git, ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
      await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true }); // the git template may have no info/ (workspaces-o9o.70)
      await fs.appendFile(path.join(dir, ".git", "info", "exclude"), ".rig-worktrees/\n");
      return fs.realpath(dir);
    }
    const NOHOOKS = ["-c", "core.hooksPath=/dev/null"];

    it("real git: 'worktree add --det <outside> HEAD' (git reads --det as --detach) is refused, naming the word; nothing is created", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      for (const [k, gitDir] of realGits().entries()) {
        const repo = await repoAt(path.join(tmp, `abbrev-${k}`), gitDir);
        const outside = path.join(tmp, `abbrev-out-${k}`);
        const r = runGit([...NOHOOKS, "worktree", "add", "--det", outside, "HEAD"], [shim, gitDir, "/usr/bin", "/bin"], repo);
        expect(r.status, `${gitDir}: ${r.stderr}`).toBe(128);
        expect(r.stderr, gitDir).toBe("openrig git shim: refusing worktree add with option --det: spell the option in full\n");
        expect(existsSync(outside), `${gitDir}: nothing at the path asked for`).toBe(false);
        const list = spawnSync(path.join(gitDir, "git"), ["-C", repo, "worktree", "list", "--porcelain"]).stdout.toString();
        expect(list.match(/^worktree /gm)?.length, list).toBe(1);
      }
    });

    // Every word git would read as an option that the shim does not know, inside or outside path alike: unique prefixes
    // of the options it knows (git accepts each), clusters, and an attached-value cluster. Git never runs.
    const UNCLASSIFIED: Array<[string[], string]> = [
      [["--det"], "--det"], [["--detac"], "--detac"], [["--for"], "--for"], [["--no-chec"], "--no-chec"],
      [["--rea", "x"], "--rea"], [["--lock", "--rea", "x"], "--rea"], [["--qui"], "--qui"], [["--orph"], "--orph"],
      [["-fd"], "-fd"], [["-fB", "feat"], "-fB"], [["--some-future-option"], "--some-future-option"],
    ];
    for (const [words, named] of UNCLASSIFIED) {
      it(`'worktree add ${words.join(" ")} <path>' is refused naming ${named}, whether the path is inside or outside; git does not run`, async () => {
        const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
        const top = path.join(tmp, "top");
        await fs.mkdir(top, { recursive: true });
        for (const target of [path.join(tmp, "elsewhere", "wt"), ".rig-worktrees/in"]) {
          const r = runGit(["worktree", "add", ...words, target], [shim, await prefGitDir(), "/usr/bin", "/bin"], top);
          expect(r.status, target).toBe(128);
          expect(r.stdout, `${target}: git did not run`).toBe("");
          expect(r.stderr, target).toBe(`openrig git shim: refusing worktree add with option ${named}: spell the option in full\n`);
        }
      });
    }

    // Before the subcommand: an unknown global option, or one that moves the repository (so the shim cannot judge where
    // the tree goes), refuses a call that goes on to worktree add. GIT_DIR and GIT_WORK_TREE in the environment move it
    // the same way, and the shim reads its own environment.
    for (const [words, named, why] of [
      [["-x"], "-x", "spell the option in full"], [["--frobnicate"], "--frobnicate", "spell the option in full"],
      [["-Cr"], "-Cr", "spell the option in full"], [["-ca.b=1"], "-ca.b=1", "spell the option in full"],
      [["--git-dir", "x/.git"], "--git-dir", "it moves the repository; run worktree add without it"],
      [["--git-dir=x/.git"], "--git-dir", "it moves the repository; run worktree add without it"],
      [["--work-tree", "x"], "--work-tree", "it moves the repository; run worktree add without it"],
      [["--work-tree=x"], "--work-tree", "it moves the repository; run worktree add without it"],
      [["--bare"], "--bare", "it moves the repository; run worktree add without it"],
    ] as const) {
      it(`'git ${words.join(" ")} worktree add <outside>' is refused naming ${named}; git does not run`, async () => {
        const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
        const r = runGit([...words, "worktree", "add", path.join(tmp, "elsewhere", "wt")], [shim, await prefGitDir(), "/usr/bin", "/bin"], tmp);
        expect(r.status).toBe(128);
        expect(r.stdout, "git did not run").toBe("");
        expect(r.stderr).toBe(`openrig git shim: refusing worktree add with option ${named}: ${why}\n`);
      });
    }
    for (const name of ["GIT_DIR", "GIT_WORK_TREE"]) {
      it(`${name} in the environment refuses a worktree add, inside path or outside, and leaves every other call alone`, async () => {
        const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
        const top = path.join(tmp, "top");
        await fs.mkdir(top, { recursive: true });
        for (const target of [path.join(tmp, "elsewhere", "wt"), ".rig-worktrees/in"]) {
          const r = runGit(["worktree", "add", target], [shim, await prefGitDir(), "/usr/bin", "/bin"], top, { [name]: path.join(tmp, "x") });
          expect(r.status, target).toBe(128);
          expect(r.stdout, `${target}: git did not run`).toBe("");
          expect(r.stderr, target).toBe(`openrig git shim: refusing worktree add with ${name} set: it moves the repository; run worktree add without it\n`);
        }
        const other = runGit(["status"], [shim, await prefGitDir(), "/usr/bin", "/bin"], top, { [name]: path.join(tmp, "x") });
        expect(other.stdout).toBe("PREF status\n");
        expect(other.stderr).toBe("");
      });
    }

    it("real git, the repo's path ending in a newline: a relative inside path from its own folder is not refused, and the tree is made there", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      for (const [k, gitDir] of realGits().entries()) {
        const repo = await repoAt(path.join(tmp, `nlcwd-${k}`, "repo\n"), gitDir);
        const r = runGit([...NOHOOKS, "worktree", "add", "-b", `in-${k}`, ".rig-worktrees/in"], [shim, gitDir, "/usr/bin", "/bin"], repo);
        expect(r.status, `${gitDir}: ${r.stderr}`).toBe(0);
        expect(r.stderr, gitDir).not.toContain("openrig git shim");
        expect(existsSync(path.join(repo, ".rig-worktrees", "in", ".git")), gitDir).toBe(true);
      }
    });

    for (const [kind, make] of [
      ["dangling, to a missing outside dir", async (portal: string, out: string) => fs.symlink(path.join(out, "missing"), portal)],
      ["to an outside file", async (portal: string, out: string) => { await fs.writeFile(path.join(out, "afile"), "x"); await fs.symlink(path.join(out, "afile"), portal); }],
    ] as const) {
      it(`real git: a symlink under .rig-worktrees ${kind} is refused as the path and on the way to it; nothing is created outside`, async () => {
        const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
        for (const [k, gitDir] of realGits().entries()) {
          const repo = await repoAt(path.join(tmp, `portal-${k}`), gitDir);
          const out = path.join(tmp, `portal-out-${k}`);
          await fs.mkdir(out);
          await fs.mkdir(path.join(repo, ".rig-worktrees"));
          await make(path.join(repo, ".rig-worktrees", "portal"), out);
          const before = (await fs.readdir(out)).sort();
          for (const target of [".rig-worktrees/portal", ".rig-worktrees/portal/wt"]) {
            const r = runGit([...NOHOOKS, "worktree", "add", "--detach", target], [shim, gitDir, "/usr/bin", "/bin"], repo);
            expect(r.status, `${gitDir} ${target}: ${r.stderr}`).toBe(128);
            expect(r.stderr, `${gitDir} ${target}`).toBe(refusal(target, repo));
          }
          expect((await fs.readdir(out)).sort(), `${gitDir}: nothing is created through the symlink`).toEqual(before);
          const list = spawnSync(path.join(gitDir, "git"), ["-C", repo, "worktree", "list", "--porcelain"]).stdout.toString();
          expect(list.match(/^worktree /gm)?.length, list).toBe(1);
        }
      });
    }
  });

  // workspaces-o9o.2: the generated file run under real bash. At d0303ca8 real_git ran 'command -v -a git'
  // (zsh syntax; bash's 'command' has no -a), built self with literal quotes, and fell back to /usr/bin/git
  // or to 'command -v git', which is the shim itself.
  // workspaces-o9o.96: the shim runs the first OTHER git on PATH, so a git wrapper found after it that runs `git` again
  // re-enters the shim, and the two run each other without end (o9o.95: 44,000 processes on sparky when the wrapper forked).
  // The shim counts its own nesting in OPENRIG_GIT_SHIM_DEPTH and refuses past 8. These wrappers exec, so a missing guard
  // spins in one process until runGit's timeout, never a fork bomb.
  describe("a git wrapper that runs git back into the shim stops (workspaces-o9o.96)", () => {
    async function gitDir(name: string, body: string): Promise<string> {
      const dir = path.join(tmp, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return dir;
    }

    it("a wrapper after the shim that runs git again is refused at depth 8 with 125, naming the wrapper", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const wrapper = await gitDir("wrapper", 'exec git "$@"');
      const r = runGit(["status"], [shim, wrapper, await prefGitDir(), "/usr/bin", "/bin"], tmp);
      expect(r.signal, "the loop ended on its own, not at the timeout").toBeNull();
      expect(r.status).toBe(125);
      expect(r.stderr).toContain("openrig git shim: 8 nested calls");
      expect(r.stderr).toContain(path.join(wrapper, "git"));
      expect(r.stdout).toBe("");
    });

    it("the git it runs sees one more level, counted from what it was given", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const echo = await gitDir("echo-depth", 'echo "depth=$OPENRIG_GIT_SHIM_DEPTH"');
      expect(runGit(["status"], [shim, echo, "/usr/bin", "/bin"], tmp).stdout).toBe("depth=1\n");
      expect(runGit(["status"], [shim, echo, "/usr/bin", "/bin"], tmp, { OPENRIG_GIT_SHIM_DEPTH: "3" }).stdout).toBe("depth=4\n");
      expect(runGit(["status"], [shim, echo, "/usr/bin", "/bin"], tmp, { OPENRIG_GIT_SHIM_DEPTH: "x7" }).stdout, "not a number counts as 0").toBe("depth=1\n");
    });

    // verify-sec review of e1b3fa061: a value too large for the shell's integers passed the digits check, made the integer
    // compare error, and the shim ran on past the guard. The value is judged as a string first: leading zeros dropped, and
    // more than 2 digits is at or over the limit.
    it("a 100-digit depth refuses with 125 and runs no git", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const r = runGit(["--version"], [shim, await prefGitDir(), "/usr/bin", "/bin"], tmp, { OPENRIG_GIT_SHIM_DEPTH: "9".repeat(100) });
      expect(r.signal).toBeNull();
      expect(r.status).toBe(125);
      expect(r.stdout, "the next git never ran").toBe("");
    });

    it("leading zeros are dropped: 0007 counts as 7 and 008 refuses", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const echo = await gitDir("echo-depth-zeros", 'echo "depth=$OPENRIG_GIT_SHIM_DEPTH"');
      expect(runGit(["status"], [shim, echo, "/usr/bin", "/bin"], tmp, { OPENRIG_GIT_SHIM_DEPTH: "0007" }).stdout).toBe("depth=8\n");
      const zeros = runGit(["status"], [shim, echo, "/usr/bin", "/bin"], tmp, { OPENRIG_GIT_SHIM_DEPTH: "000" });
      expect(zeros.stdout, "all zeros count as 0").toBe("depth=1\n");
      expect(zeros.stderr, "and no shell error on the way").toBe("");
      const refused = runGit(["status"], [shim, echo, "/usr/bin", "/bin"], tmp, { OPENRIG_GIT_SHIM_DEPTH: "008" });
      expect(refused.status).toBe(125);
      expect(refused.stdout).toBe("");
    });

    it("nesting under the limit runs through; at the limit it refuses", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const under = runGit(["--version"], [shim, await prefGitDir(), "/usr/bin", "/bin"], tmp, { OPENRIG_GIT_SHIM_DEPTH: "7" });
      expect(under.status).toBe(0);
      expect(under.stdout).toBe("PREF --version\n");
      const at = runGit(["--version"], [shim, await prefGitDir(), "/usr/bin", "/bin"], tmp, { OPENRIG_GIT_SHIM_DEPTH: "8" });
      expect(at.status).toBe(125);
      expect(at.stdout).toBe("");
    });
  });

  describe("real_git: the first git on PATH that is not this shim", () => {
    it("an ordinary git call prints no 'command: -a: invalid option' and runs the next git on PATH", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const r = runGit(["--version"], [shim, await prefGitDir(), "/usr/bin", "/bin"], tmp);
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe("PREF --version\n");
      expect(r.status).toBe(0);
    });

    it("skips the shim when it is reached again through a symlinked directory earlier on PATH (no exec loop)", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const link = path.join(tmp, "rig-bin-link");
      await fs.symlink(shim, link);
      const r = runGit(["--version"], [link, shim, await prefGitDir(), "/usr/bin", "/bin"], tmp);
      expect(r.signal, "the shim did not exec itself until the timeout").toBeNull();
      expect(r.stdout).toBe("PREF --version\n");
      expect(r.stderr).toBe("");
    });

    // verify-sec, review of 6a6c796e: the shim knew itself by its directory, so a `git` elsewhere on PATH that is
    // the shim under another name (a file symlink or a hard link) counted as a real git, and the shim exec'd
    // itself until killed. Identity is the file (device and inode), not the path.
    for (const kind of ["file symlink", "hard link"] as const) {
      it(`skips the shim when another PATH dir holds it as a ${kind} (no exec loop)`, async () => {
        const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
        const alias = path.join(tmp, "alias-dir");
        await fs.mkdir(alias);
        if (kind === "file symlink") await fs.symlink(path.join(shim, "git"), path.join(alias, "git"));
        else await fs.link(path.join(shim, "git"), path.join(alias, "git"));
        const r = runGit(["--version"], [shim, alias, await prefGitDir(), "/usr/bin", "/bin"], tmp);
        expect(r.signal, "the shim did not exec itself until the timeout").toBeNull();
        expect(r.stdout).toBe("PREF --version\n");
        expect(r.stderr).toBe("");
      });
    }

    it("with no git on PATH but the shim, fails at once with 127 and never runs a git off PATH", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const r = runGit(["--version"], [shim, await toolsDir("bash", "dirname")], tmp);
      expect(r.signal, "the shim did not exec itself until the timeout").toBeNull();
      expect(r.status).toBe(127);
      expect(r.stdout, "no git outside PATH (such as /usr/bin/git) ran").toBe("");
      expect(r.stderr).toContain("git: command not found");
    });

    it("'git worktree' with no further argument passes through instead of dying on $2 under set -u", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const r = runGit(["worktree"], [shim, await prefGitDir(), "/usr/bin", "/bin"], tmp);
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe("PREF worktree\n");
      expect(r.status).toBe(0);
    });

    it("'git worktree add' with no path passes through instead of dying on args[0] under set -u", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const r = runGit(["worktree", "add"], [shim, await prefGitDir(), "/usr/bin", "/bin"], tmp);
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe("PREF worktree add\n");
      expect(r.status).toBe(0);
    });

    // The exec loop needs a host with no /usr/bin/git, which this host cannot fake (unprivileged user namespaces
    // are refused). The bash images have no git at all, and bash:3.2 is the macOS system bash version.
    for (const image of ["bash:3.2", "bash:5.2"]) {
      it.skipIf(!dockerImagePresent(image))(
        `${image} with no /usr/bin/git: resolves the next git on PATH, no stderr, no exec loop (NOT RUN without docker and the ${image} image)`,
        async () => {
          const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
          const pref = await prefGitDir();
          const r = spawnSync("docker", [
            // --init: a looping shim must not be PID 1, which ignores the timeout's signal and hangs the row.
            "run", "--rm", "--init", "--network", "none",
            "-v", `${shim}:/s/rig-bin:ro`, "-v", `${pref}:/s/pref:ro`, image,
            "bash", "-c",
            "test ! -e /usr/bin/git || exit 99; cd /tmp; PATH=/s/rig-bin:/s/pref:/usr/local/bin:/usr/bin:/bin timeout -s KILL 5 git --version",
          ], { timeout: 60000 });
          expect(r.status, "137 is the timeout killing an exec loop; 99 is an image that has /usr/bin/git").toBe(0);
          expect(r.stdout.toString()).toBe("PREF --version\n");
          expect(r.stderr.toString()).toBe("");
        },
      );
    }

    // The alias loop under the macOS bash version: the shim reached again as a file symlink or a hard link from
    // another PATH dir. The shim is copied into the container's own filesystem first, because a hard link
    // cannot cross the read-only bind mount.
    for (const image of ["bash:3.2", "bash:5.2"]) {
      for (const [kind, link] of [["file symlink", "ln -s"], ["hard link", "ln"]] as const) {
        it.skipIf(!dockerImagePresent(image))(
          `${image}: skips the shim held as a ${kind} in another PATH dir, no exec loop (NOT RUN without docker and the ${image} image)`,
          async () => {
            const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
            const pref = await prefGitDir();
            const r = spawnSync("docker", [
              "run", "--rm", "--init", "--network", "none",
              "-v", `${shim}:/s/rig-bin:ro`, "-v", `${pref}:/s/pref:ro`, image,
              "bash", "-c",
              `mkdir -p /rb /alias && cp /s/rig-bin/git /rb/git && chmod 755 /rb/git && ${link} /rb/git /alias/git && ` +
                "cd /tmp && PATH=/rb:/alias:/s/pref:/usr/local/bin:/usr/bin:/bin timeout -s KILL 5 git --version",
            ], { timeout: 60000 });
            expect(r.status, "137 is the timeout killing an exec loop").toBe(0);
            expect(r.stdout.toString()).toBe("PREF --version\n");
            expect(r.stderr.toString()).toBe("");
          },
        );
      }
    }
  });

  // workspaces-o9o.5: the shim must find the path word by git's grammar. At 6a6c796e the shim rebuilt the call from
  // the positional words alone, so -b/-B and every flag were dropped; it also parsed --track and --guess-remote as
  // taking a value (git 2.43.0's `git worktree add -h` lists both as booleans), and rewrote an inside path given
  // relative. Since workspaces-o9o.102 an outside path is refused, not rewritten: every known option form is pinned
  // twice, an inside path reaching git byte-for-byte and an outside one refused by name before git runs.
  describe("worktree add: the path word found by git's grammar, inside unchanged, outside refused", () => {
    const REFUSED_OPTION = "openrig git shim: refusing worktree add with option ";

    /** A git stand-in that prints its argv NUL-separated; rev-parse answers the physical cwd as the toplevel. */
    async function recordingGitDir(): Promise<string> {
      const dir = path.join(tmp, "recording");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "git"),
        "#!/bin/sh\nif [ \"$1\" = rev-parse ]; then pwd -P; exit 0; fi\nfor a in \"$@\"; do printf '%s\\0' \"$a\"; done\n",
        { mode: 0o755 },
      );
      return dir;
    }

    async function setup() {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const top = path.join(tmp, "top");
      await fs.mkdir(top, { recursive: true });
      const realTop = await fs.realpath(top);
      const outside = path.join(tmp, "elsewhere", "wt");
      const pathDirs = [shim, await recordingGitDir(), "/usr/bin", "/bin"];
      const run = (args: string[]) => {
        const r = runGit(["worktree", "add", ...args], pathDirs, top);
        return { ...r, argv: r.stdout.split("\0").slice(0, -1) };
      };
      /** Refused: exit 128, the one line naming the target and this toplevel, and git never ran. */
      const expectRefused = (r: ReturnType<typeof run>, target: string) => {
        expect(r.status, r.stderr).toBe(128);
        expect(r.argv, "git did not run").toEqual([]);
        expect(r.stderr).toBe(refusal(target, realTop));
      };
      return { top, realTop, outside, run, expectRefused };
    }

    // One row per option form in git 2.43.0's `git worktree add -h`, the --no-* forms and the attached forms.
    const KNOWN_FORMS: string[][] = [
      ["-f"], ["--force"], ["--no-force"],
      ["-b", "feat"], ["-bfeat"], ["-B", "feat"], ["-Bfeat"],
      ["--orphan"], ["--no-orphan"],
      ["-d"], ["--detach"], ["--no-detach"],
      ["--checkout"], ["--no-checkout"],
      ["--lock"], ["--no-lock"], ["--lock", "--reason", "why not"], ["--lock", "--reason=why"], ["--no-reason"],
      ["-q"], ["--quiet"], ["--no-quiet"],
      ["--track", "-b", "feat"], ["--no-track"],
      ["--guess-remote", "-b", "feat"], ["--no-guess-remote"],
    ];

    for (const form of KNOWN_FORMS) {
      it(`'${form.join(" ")}' then a path: an inside one reaches git with every word, an outside one is refused`, async () => {
        const { realTop, outside, run, expectRefused } = await setup();
        const inside = path.join(realTop, ".rig-worktrees", "wt");
        const r = run([...form, inside]);
        expect(r.argv).toEqual(["worktree", "add", ...form, inside]);
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        expectRefused(run([...form, outside]), outside);
      });
    }

    it("the commit-ish and options after the path: kept in order for an inside path, an outside one refused", async () => {
      const { realTop, outside, run, expectRefused } = await setup();
      const inside = path.join(realTop, ".rig-worktrees", "wt");
      const r = run(["-b", "feat", inside, "HEAD~0", "--quiet"]);
      expect(r.argv).toEqual(["worktree", "add", "-b", "feat", inside, "HEAD~0", "--quiet"]);
      expect(r.stderr).toBe("");
      expectRefused(run(["-b", "feat", outside, "HEAD~0", "--quiet"]), outside);
    });

    it("after '--' the next word is the path, even when it starts with a dash", async () => {
      const { run, expectRefused } = await setup();
      expectRefused(run(["-b", "feat", "--", "-wt"]), "-wt");
      const r = run(["-b", "feat", "--", ".rig-worktrees/-wt"]);
      expect(r.argv).toEqual(["worktree", "add", "-b", "feat", "--", ".rig-worktrees/-wt"]);
      expect(r.stderr).toBe("");
    });

    // workspaces-o9o.102 (verify-sec, review of 28dacd923): an option the shim does not know used to pass through
    // unchecked; git reads '--det' as --detach, so that was a way out. It is refused, naming the word.
    for (const unknown of [["--det"], ["-fq"], ["--lock", "--rea", "x"], ["--some-future-option"]]) {
      it(`an option the shim does not know ('${unknown.join(" ")}') is refused with one stderr line; git does not run`, async () => {
        const { outside, run } = await setup();
        const r = run([...unknown, outside]);
        expect(r.argv, "git did not run").toEqual([]);
        const word = unknown.find(w => w.startsWith("-") && !["--lock"].includes(w));
        expect(r.stderr).toBe(`${REFUSED_OPTION}${word}: spell the option in full\n`);
        expect(r.status).toBe(128);
      });
    }

    it("an inside path given absolute or relative reaches git byte-for-byte unchanged", async () => {
      const { realTop, run } = await setup();
      for (const inside of [path.join(realTop, ".rig-worktrees", "in"), ".rig-worktrees/in", "./.rig-worktrees/in"]) {
        const r = run(["-b", "feat", inside]);
        expect(r.argv, inside).toEqual(["worktree", "add", "-b", "feat", inside]);
        expect(r.stderr, inside).toBe("");
      }
    });

    it("from a cwd reached through a symlink (macOS /tmp), a relative inside path is still recognised as inside", async () => {
      const { top, realTop } = await setup();
      const linked = path.join(tmp, "linked-top");
      await fs.symlink(realTop, linked);
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      // A shell that cd'd through the symlink exports the logical PWD; without it bash falls back to the
      // physical getcwd() and the symlink is never seen.
      const r = runGit(["worktree", "add", "-b", "feat", ".rig-worktrees/in"], [shim, await recordingGitDir(), "/usr/bin", "/bin"], linked, { PWD: linked });
      expect(top).not.toBe(linked);
      expect(r.stdout.split("\0").slice(0, -1)).toEqual(["worktree", "add", "-b", "feat", ".rig-worktrees/in"]);
      expect(r.stderr).toBe("");
    });

    it("'--' with nothing after it passes through to git unchanged", async () => {
      const { run } = await setup();
      const r = run(["-b", "feat", "--"]);
      expect(r.argv).toEqual(["worktree", "add", "-b", "feat", "--"]);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });

    // bash 3.2 (the macOS system bash) differs from the host's 5.x in ways the host rows cannot see: in 3.2 a
    // backslash in a ${var//pat/rep} replacement stays in the result. Same assertions, in the 3.2 image.
    it.skipIf(!dockerImagePresent("bash:3.2"))(
      "bash:3.2: a relative './' inside path is unchanged and '-b feat <outside>' is refused before git runs (NOT RUN without docker and the bash:3.2 image)",
      async () => {
        const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
        const rec = await recordingGitDir();
        const r = spawnSync("docker", [
          "run", "--rm", "--init", "--network", "none",
          "-v", `${shim}:/s/rig-bin:ro`, "-v", `${rec}:/s/rec:ro`, "bash:3.2",
          "bash", "-c",
          "mkdir -p /top && cd /top && export PATH=/s/rig-bin:/s/rec:/usr/local/bin:/usr/bin:/bin; " +
            "timeout -s KILL 5 git worktree add -b feat ./.rig-worktrees/in; printf '\\n'; " +
            "timeout -s KILL 5 git worktree add -b feat /elsewhere/wt; printf 'rc=%s' $?",
        ], { timeout: 60000 });
        expect(r.status).toBe(0);
        expect(r.stderr.toString()).toBe(refusal("/elsewhere/wt", "/top"));
        const [inside, outside] = r.stdout.toString().split("\n");
        expect((inside ?? "").split("\0").slice(0, -1)).toEqual(["worktree", "add", "-b", "feat", "./.rig-worktrees/in"]);
        expect(outside, "git did not run, and the shim exited 128").toBe("rc=128");
      },
    );

    it("real git: 'worktree add -b feat <outside>' is refused: no branch feat, no worktree anywhere", async () => {
      const repo = path.join(tmp, "repo");
      await fs.mkdir(repo);
      const git = path.join(realGitDir(), "git");
      expect(spawnSync(git, ["init", "-q", repo]).status).toBe(0);
      expect(spawnSync(git, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
      await fs.mkdir(path.join(repo, ".git", "info"), { recursive: true }); // the git template may have no info/ (workspaces-o9o.70)
      await fs.appendFile(path.join(repo, ".git", "info", "exclude"), ".rig-worktrees/\n");
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const r = runGit(["worktree", "add", "-b", "feat", path.join(tmp, "outside-b")], [shim, realGitDir(), "/usr/bin", "/bin"], repo);
      expect(r.status, r.stderr).toBe(128);
      expect(r.stderr).toBe(refusal(path.join(tmp, "outside-b"), await fs.realpath(repo)));
      expect(spawnSync(git, ["-C", repo, "branch", "--list", "feat"]).stdout.toString(), "no branch feat").toBe("");
      expect(existsSync(path.join(tmp, "outside-b"))).toBe(false);
      expect(existsSync(path.join(repo, ".rig-worktrees"))).toBe(false);
    });

    // verify-sec, review of 6dc59b2b (FAIL 1/3): "inside" was judged on the path's text, so a '..' out of
    // .rig-worktrees or a symlink inside it ("portal") passed as inside and git created the worktree outside. The
    // absolute forms have escaped since the shim's first commit (a2258408e). Inside is now the PHYSICAL path.
    async function realRepo() {
      const repo = path.join(tmp, "repo");
      await fs.mkdir(repo);
      const git = path.join(realGitDir(), "git");
      expect(spawnSync(git, ["init", "-q", repo]).status).toBe(0);
      expect(spawnSync(git, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
      await fs.mkdir(path.join(repo, ".git", "info"), { recursive: true }); // the git template may have no info/ (workspaces-o9o.70)
      await fs.appendFile(path.join(repo, ".git", "info", "exclude"), ".rig-worktrees/\n");
      const realRepoDir = await fs.realpath(repo);
      await fs.mkdir(path.join(realRepoDir, ".rig-worktrees"));
      const portalTarget = path.join(tmp, "portal-target");
      await fs.mkdir(portalTarget);
      await fs.symlink(portalTarget, path.join(realRepoDir, ".rig-worktrees", "portal"));
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const run = (args: string[]) => runGit(["worktree", "add", ...args], [shim, realGitDir(), "/usr/bin", "/bin"], realRepoDir);
      return { repo: realRepoDir, git, portalTarget, run };
    }

    for (const form of ["relative", "absolute"] as const) {
      it(`real git, ${form}: '.rig-worktrees/../escaped-wt' does not escape; it is refused`, async () => {
        const { repo, run } = await realRepo();
        const target = form === "relative" ? "./.rig-worktrees/../escaped-wt" : `${repo}/.rig-worktrees/../escaped-wt`; // not path.join, which would fold the ".." away
        const r = run(["-b", "escaped", target]);
        expect(r.status, r.stderr).toBe(128);
        expect(r.stderr).toBe(refusal(target, repo));
        expect(existsSync(path.join(repo, "escaped-wt")), "nothing is created beside .rig-worktrees").toBe(false);
        expect(existsSync(path.join(repo, ".rig-worktrees", "escaped-wt")), "nor inside it").toBe(false);
      });

      it(`real git, ${form}: a symlink inside .rig-worktrees to an outside dir is not a way out; it is refused`, async () => {
        const { repo, portalTarget, run } = await realRepo();
        const target = form === "relative" ? "./.rig-worktrees/portal/escaped-symlink" : path.join(repo, ".rig-worktrees", "portal", "escaped-symlink");
        const r = run(["-b", "escaped", target]);
        expect(r.status, r.stderr).toBe(128);
        expect(r.stderr).toBe(refusal(target, repo));
        expect(existsSync(path.join(portalTarget, "escaped-symlink")), "nothing is created in the symlink's target").toBe(false);
        expect(existsSync(path.join(repo, ".rig-worktrees", "escaped-symlink")), "nor beside the symlink").toBe(false);
      });
    }

    // verify-sec, review of cc9a1496 (FAIL 2/3): the leaf was checked for a symlink but not .rig-worktrees itself, so
    // with the ROOT a symlink to an outside dir, mkdir -p and git both followed it and the worktree landed outside.
    // A path under the symlinked root resolves outside, so it is refused like any outside path.
    it("real git: when .rig-worktrees itself is a symlink to an outside dir, outside and through-the-root paths are refused and nothing lands there", async () => {
      const repo = path.join(tmp, "rootlink");
      await fs.mkdir(repo);
      const git = path.join(realGitDir(), "git");
      expect(spawnSync(git, ["init", "-q", repo]).status).toBe(0);
      expect(spawnSync(git, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
      const outside = path.join(tmp, "root-target");
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(repo, ".rig-worktrees"));
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const realRepoDir = await fs.realpath(repo);
      const r = runGit(["worktree", "add", "-b", "escape", path.join(tmp, "outside2", "asked")], [shim, realGitDir(), "/usr/bin", "/bin"], repo);
      expect(r.status).toBe(128);
      expect(r.stderr).toBe(refusal(path.join(tmp, "outside2", "asked"), realRepoDir));
      const through = runGit(["worktree", "add", "-b", "escape2", ".rig-worktrees/through"], [shim, realGitDir(), "/usr/bin", "/bin"], repo);
      expect(through.status, through.stderr).toBe(128);
      expect(through.stderr).toBe(refusal(".rig-worktrees/through", realRepoDir));
      expect(await fs.readdir(outside), "nothing is created through the symlinked root").toEqual([]);
      expect(existsSync(path.join(tmp, "outside2")), "nor at the path asked for").toBe(false);
    });

    it("when .rig-worktrees exists but is not a directory, an outside path is refused before git runs", async () => {
      const { realTop, outside, run, expectRefused } = await setup();
      await fs.writeFile(path.join(realTop, ".rig-worktrees"), "not a dir\n");
      expectRefused(run(["-b", "feat", outside]), outside);
    });

    it("real git: the portal itself as the path ('.rig-worktrees/portal', a symlink to an empty outside dir) is refused", async () => {
      const { repo, portalTarget, run } = await realRepo();
      const r = run(["-b", "escaped", ".rig-worktrees/portal"]);
      expect(r.status).toBe(128);
      expect(r.stderr).toBe(refusal(".rig-worktrees/portal", repo));
      expect(await fs.readdir(portalTarget), "nothing is checked out in the symlink's target").toEqual([]);
    });

    it("a '..' through a .rig-worktrees dir that exists, ending inside, is still inside and reaches git unchanged", async () => {
      const { realTop, run } = await setup();
      await fs.mkdir(path.join(realTop, ".rig-worktrees", "a"), { recursive: true });
      for (const inside of [".rig-worktrees/a/../in", `${realTop}/.rig-worktrees/a/../in`]) {
        const r = run(["-b", "feat", inside]);
        expect(r.argv, inside).toEqual(["worktree", "add", "-b", "feat", inside]);
        expect(r.stderr, inside).toBe("");
      }
    });

    it("a '..' in the part of the path that does not exist yet counts as outside: refused", async () => {
      const { run, expectRefused } = await setup();
      expectRefused(run(["-b", "feat", ".rig-worktrees/not-yet/../wt2"]), ".rig-worktrees/not-yet/../wt2");
    });

    it("a trailing slash on an outside path: refused, the path named as given", async () => {
      const { outside, run, expectRefused } = await setup();
      expectRefused(run(["-b", "feat", outside + "/"]), outside + "/");
    });

    // '', '.', '..' and the root: outside paths like any other, among them the shapes that made .rig-worktrees itself
    // the worktree under the old redirect (measured at 6dc59b2b: `git worktree add -b dot <outside>/.`). A control
    // character in the path stays quoted on the one line.
    for (const target of ["..", "../..", "/", "/elsewhere/.", ".", "/bad\u001b[31m\nname/."]) {
      it(`an outside path (${JSON.stringify(target)}) is refused: exit 128, one quoted stderr line, git not run`, async () => {
        const { run } = await setup();
        const r = run(["-b", "feat", target]);
        expect(r.status).toBe(128);
        expect(r.argv, "git did not run").toEqual([]);
        expect(r.stderr).toMatch(REFUSAL);
        expect(/[\u0000-\u001f\u007f]/.test(r.stderr.slice(0, -1)), JSON.stringify(r.stderr)).toBe(false);
      });
    }

    it("a real dir named '.rig-worktrees<newline>' is not .rig-worktrees: a path through it is refused", async () => {
      const { top, run } = await setup();
      await fs.mkdir(path.join(top, ".rig-worktrees\n"));
      const r = run(["-b", "feat", ".rig-worktrees\n/wt"]);
      expect(r.status).toBe(128);
      expect(r.argv, "git did not run").toEqual([]);
      expect(r.stderr).toMatch(REFUSAL);
    });

    // The physical-path check, the refusal, the newline and the quoted diagnostic under the macOS bash version.
    it.skipIf(!dockerImagePresent("bash:3.2"))(
      "bash:3.2: '..', a symlink portal, a trailing newline and '.' are refused with exit 128 on one quoted line, the notice is one line (NOT RUN without docker and the bash:3.2 image)",
      async () => {
        const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
        const rec = await recordingGitDir();
        const r = spawnSync("docker", [
          "run", "--rm", "--init", "--network", "none",
          "-v", `${shim}:/s/rig-bin:ro`, "-v", `${rec}:/s/rec:ro`, "bash:3.2",
          "bash", "-c",
          "mkdir -p /top/.rig-worktrees /out && ln -s /out /top/.rig-worktrees/portal && cd /top && " +
            "export PATH=/s/rig-bin:/s/rec:/usr/local/bin:/usr/bin:/bin; " +
            "timeout -s KILL 5 git worktree add -b f ./.rig-worktrees/../esc 2>&1; printf 'rc=%s\\036' $?; " +
            "timeout -s KILL 5 git worktree add -b f ./.rig-worktrees/portal/x 2>&1; printf 'rc=%s\\036' $?; " +
            "timeout -s KILL 5 git worktree add -b f $'/elsewhere/wt\\n' 2>&1; printf 'rc=%s\\036' $?; " +
            "timeout -s KILL 5 git worktree add -b f /elsewhere/. 2>&1; printf 'rc=%s\\036' $?; " +
            "timeout -s KILL 5 git worktree add $'--x\\033[31m\\nforged' /elsewhere/wt 2>&1 >/dev/null; printf '\\036rc=%s' $?",
        ], { timeout: 60000 });
        expect(r.status).toBe(0);
        const [dotdot, portal, newline, dot, diag, diagRc] = r.stdout.toString().split("\u001e");
        expect(diagRc, "the unknown option is refused").toBe("rc=128");
        expect(dotdot).toBe(`${refusal("./.rig-worktrees/../esc", "/top")}rc=128`);
        expect(portal).toBe(`${refusal("./.rig-worktrees/portal/x", "/top")}rc=128`);
        expect(newline).toBe("openrig git shim: refusing worktree path $'/elsewhere/wt\\n': seat worktrees go in /top/.rig-worktrees/<name>\nrc=128");
        expect(dot).toBe(`${refusal("/elsewhere/.", "/top")}rc=128`);
        expect(diag?.startsWith(REFUSED_OPTION)).toBe(true);
        expect(/[\u0000-\u001f\u007f]/.test((diag ?? "").slice(0, -1)), JSON.stringify(diag)).toBe(false);
        expect(r.stderr.toString()).toBe("");
      },
    );

    it("real git: 'worktree add -b dot <outside>/.' is refused and makes no worktree", async () => {
      const repo = path.join(tmp, "fresh");
      await fs.mkdir(repo);
      const git = path.join(realGitDir(), "git");
      expect(spawnSync(git, ["init", "-q", repo]).status).toBe(0);
      expect(spawnSync(git, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
      const other = path.join(tmp, "other");
      await fs.mkdir(other);
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const r = runGit(["worktree", "add", "-b", "dot", other + "/."], [shim, realGitDir(), "/usr/bin", "/bin"], repo);
      expect(r.status).toBe(128);
      const list = spawnSync(git, ["-C", repo, "worktree", "list", "--porcelain"]).stdout.toString();
      expect(list.match(/^worktree /gm)?.length, list).toBe(1);
    });

    // verify-sec finding 2: $(basename ...) dropped a trailing newline from the path word.
    it("a path word ending in a newline is named quoted on one line when refused, and an inside one is unchanged", async () => {
      const { realTop, run } = await setup();
      const outsideNl = path.join(tmp, "elsewhere", "wt\n");
      const r = run(["-b", "feat", outsideNl]);
      expect(r.status).toBe(128);
      expect(r.argv, "git did not run").toEqual([]);
      expect(r.stderr).toBe(`openrig git shim: refusing worktree path $'${outsideNl.slice(0, -1)}\\n': seat worktrees go in ${realTop}/.rig-worktrees/<name>\n`);
      const r2 = run(["-b", "feat", ".rig-worktrees/in\n"]);
      expect(r2.argv).toEqual(["worktree", "add", "-b", "feat", ".rig-worktrees/in\n"]);
      expect(r2.stderr).toBe("");
    });

    // verify-sec finding 3: the unknown word went raw into the diagnostic, so a newline split it and an escape
    // sequence reached the terminal.
    for (const word of ["--x\nforged line", "--\u001b[31mred", "--bell\u0007"]) {
      it(`an unknown option with control characters (${JSON.stringify(word)}) is quoted in a one-line diagnostic`, async () => {
        const { outside, run } = await setup();
        const r = run([word, outside]);
        expect(r.status).toBe(128);
        expect(r.argv, "git did not run").toEqual([]);
        expect(r.stderr.startsWith(REFUSED_OPTION)).toBe(true);
        expect(r.stderr.endsWith(": spell the option in full\n")).toBe(true);
        // No control character but the final newline.
        expect(/[\u0000-\u001f\u007f]/.test(r.stderr.slice(0, -1)), JSON.stringify(r.stderr)).toBe(false);
      });
    }
  });

  // workspaces-o9o.24: git's global options come before the subcommand ('git -C <dir> worktree add ...', which
  // CULTURE recommends from a seat folder). At 6dc59b2b the shim governed worktree add only when $1 was
  // 'worktree', so every global option bypassed the placement rule. Option grammar measured on git 2.43.0
  // (/usr/bin/git) and 2.55.0 (linuxbrew) on Sparky, 2026-11-16: 'git -h', 'git help git' and running each form.
  describe("global options before the subcommand", () => {
    /** A git stand-in that applies leading '-C <dir>' words as git does (cd in order, '' is a no-op), answers
     * rev-parse with the physical cwd as the toplevel, and otherwise (a failed -C included) prints its argv
     * NUL-separated. */
    async function globalRecordingGitDir(): Promise<string> {
      const dir = path.join(tmp, "grecording");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "git"),
        [
          "#!/usr/bin/env bash",
          "unset CDPATH # git's chdir for -C ignores it",
          'args=("$@"); i=0',
          'while [ "$i" -lt "$#" ] && [ "${args[$i]}" = -C ]; do',
          '  d="${args[$((i+1))]}"; if [ -n "$d" ]; then cd "$d" 2>/dev/null || break; fi; i=$((i+2))',
          "done",
          'if [ "${args[$i]:-}" = rev-parse ]; then pwd -P; exit 0; fi',
          "for a in \"$@\"; do printf '%s\\0' \"$a\"; done",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      return dir;
    }

    async function setup() {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const top = path.join(tmp, "top");
      await fs.mkdir(path.join(top, "sub"), { recursive: true });
      const realTop = await fs.realpath(top);
      const realTmp = await fs.realpath(tmp);
      const outside = path.join(tmp, "elsewhere", "wt");
      const pathDirs = [shim, await globalRecordingGitDir(), "/usr/bin", "/bin"];
      const run = (args: string[], cwd: string = top) => {
        const r = runGit(args, pathDirs, cwd);
        return { ...r, argv: r.stdout.split("\0").slice(0, -1) };
      };
      /** Refused under `toplevel` (the repo the global options moved to): exit 128, the one line, git never ran. */
      const expectRefused = (r: ReturnType<typeof run>, target: string, toplevel: string = realTop) => {
        expect(r.status, r.stderr).toBe(128);
        expect(r.argv, "git did not run").toEqual([]);
        expect(r.stderr).toBe(refusal(target, toplevel));
      };
      return { top, realTop, realTmp, outside, run, expectRefused };
    }

    // Every global option that does not move the repo, in each form git accepts. Value options take the next word
    // ('-c' and '-C' take only that form: '-ca.b=1' and '-Cr' are unknown options to both versions).
    const LOCATION_NEUTRAL: string[][] = [
      ["-c", "a.b=1"], ["-c", "-x=1"],
      ["--config-env", "a.b=HOME"], ["--config-env=a.b=HOME"],
      ["--namespace", "ns"], ["--namespace=ns"],
      ["--attr-source", "HEAD"], ["--attr-source=HEAD"],
      ["--exec-path=/nonexistent"],
      ["-p"], ["--paginate"], ["-P"], ["--no-pager"],
      ["--no-replace-objects"], ["--literal-pathspecs"], ["--glob-pathspecs"], ["--noglob-pathspecs"],
      ["--icase-pathspecs"], ["--no-optional-locks"],
      ["--no-lazy-fetch"], ["--no-advice"], // 2.55.0 only; 2.43.0 rejects them itself
      ["-C", ""], ["-C", "."],
      ["-c", "a.b=1", "--no-pager", "-C", "."],
    ];

    for (const globals of LOCATION_NEUTRAL) {
      it(`'git ${globals.map(w => w || "''").join(" ")} worktree add -b feat <path>': an outside path is refused, an inside one reaches git with every word`, async () => {
        const { realTop, outside, run, expectRefused } = await setup();
        expectRefused(run([...globals, "worktree", "add", "-b", "feat", outside]), outside);
        const inside = path.join(realTop, ".rig-worktrees", "wt");
        const r = run([...globals, "worktree", "add", "-b", "feat", inside]);
        expect(r.argv).toEqual([...globals, "worktree", "add", "-b", "feat", inside]);
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
      });
    }

    it("'git -C <repo> worktree add <outside>' from outside the repo is refused, naming that repo's toplevel", async () => {
      const { top, outside, run, expectRefused } = await setup();
      expectRefused(run(["-C", top, "worktree", "add", outside], tmp), outside);
    });

    it("a relative path after -C resolves from the -C dir: '../elsewhere/wt' is outside, so refused", async () => {
      const { run, expectRefused } = await setup();
      expectRefused(run(["-C", "top", "worktree", "add", "-b", "feat", "../elsewhere/wt"], tmp), "../elsewhere/wt");
    });

    it("a relative inside path after -C resolves from the -C dir and reaches git unchanged", async () => {
      const { run } = await setup();
      const r = run(["-C", "top", "worktree", "add", ".rig-worktrees/in"], tmp);
      expect(r.argv).toEqual(["-C", "top", "worktree", "add", ".rig-worktrees/in"]);
      expect(r.stderr).toBe("");
    });

    it("-C words chain, each relative to the one before: '-C top -C sub' and '../.rig-worktrees/in' is inside", async () => {
      const { realTop, run, expectRefused } = await setup();
      // The stand-in's toplevel is the cwd it ends in (top/sub), so the inside dir is top/sub/.rig-worktrees.
      const r = run(["-C", "top", "-C", "sub", "worktree", "add", ".rig-worktrees/in"], tmp);
      expect(r.argv).toEqual(["-C", "top", "-C", "sub", "worktree", "add", ".rig-worktrees/in"]);
      expect(r.stderr).toBe("");
      expectRefused(run(["-C", "top", "-C", "sub", "worktree", "add", "../elsewhere-wt"], tmp), "../elsewhere-wt", path.join(realTop, "sub"));
    });

    it("a CDPATH in the caller's env does not move a relative -C dir (git's own chdir ignores CDPATH)", async () => {
      const { top, realTop, outside } = await setup();
      const decoy = path.join(tmp, "decoy");
      await fs.mkdir(path.join(decoy, "top"), { recursive: true });
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const r = runGit(["-C", "top", "worktree", "add", outside], [shim, await globalRecordingGitDir(), "/usr/bin", "/bin"], tmp, { CDPATH: decoy });
      expect(top).toBe(path.join(tmp, "top"));
      expect(r.status).toBe(128);
      expect(r.stderr, "refused under top, not under the CDPATH decoy").toBe(refusal(outside, realTop));
    });

    it("a -C dir that does not exist: git gets the call unchanged and reports it itself", async () => {
      const { outside, run } = await setup();
      const r = run(["-C", "no-such-dir", "worktree", "add", outside], tmp);
      expect(r.argv).toEqual(["-C", "no-such-dir", "worktree", "add", outside]);
      expect(r.stderr).toBe("");
    });

    // --git-dir, --work-tree and --bare move what git calls the toplevel (with --git-dir alone it is the cwd), so where
    // the tree would go cannot be judged: a call that goes on to worktree add is refused, naming the option
    // (workspaces-o9o.102, verify-sec: fail closed; it used to pass through with a notice).
    for (const globals of [["--git-dir", "x/.git"], ["--git-dir=x/.git"], ["--work-tree", "x"], ["--work-tree=x"], ["--bare"]]) {
      it(`'${globals.join(" ")}' before worktree add: refused, one stderr line naming the option; git does not run`, async () => {
        const { outside, run } = await setup();
        const r = run([...globals, "worktree", "add", outside]);
        expect(r.argv, "git did not run").toEqual([]);
        expect(r.stderr).toBe(`openrig git shim: refusing worktree add with option ${(globals[0] ?? "").split("=")[0]}: it moves the repository; run worktree add without it\n`);
        expect(r.status).toBe(128);
      });
    }

    // An option the shim does not know stops the scan. A call that goes on to 'worktree add' is refused, naming it; any
    // other git call goes through silently (the row below).
    for (const unknown of ["-x", "--frobnicate", "-Cr", "-ca.b=1", "--"]) {
      it(`unknown global '${unknown}' before worktree add: refused, one stderr line; git does not run`, async () => {
        const { outside, run } = await setup();
        const r = run([unknown, "worktree", "add", outside]);
        expect(r.argv, "git did not run").toEqual([]);
        expect(r.stderr).toBe(`openrig git shim: refusing worktree add with option ${unknown}: spell the option in full\n`);
        expect(r.status).toBe(128);
      });
    }

    it("an unknown global with control characters before worktree add is quoted in a one-line refusal", async () => {
      const { outside, run } = await setup();
      for (const word of ["--x\nforged line", "--\u001b[31mred"]) {
        const r = run([word, "worktree", "add", outside]);
        expect(r.status).toBe(128);
        expect(r.argv, "git did not run").toEqual([]);
        expect(r.stderr.startsWith("openrig git shim: refusing worktree add with option ")).toBe(true);
        expect(/[\u0000-\u001f\u007f]/.test(r.stderr.slice(0, -1)), JSON.stringify(r.stderr)).toBe(false);
      }
    });

    it("an unknown global on any other git call passes through silently", async () => {
      const { run } = await setup();
      for (const args of [["--frobnicate", "status"], ["-x", "log", "worktree"], ["-x", "worktree", "list"]]) {
        const r = run(args);
        expect(r.argv, args.join(" ")).toEqual(args);
        expect(r.stderr, args.join(" ")).toBe("");
      }
    });

    // Options after which git prints and exits: no subcommand runs, nothing to check, nothing to say.
    for (const terminal of [["-v"], ["--version"], ["-h"], ["--help"], ["--exec-path"], ["--html-path"], ["--man-path"], ["--info-path"], ["--list-cmds=main"]]) {
      it(`'${terminal[0]}' then 'worktree add <outside>': unchanged and silent`, async () => {
        const { outside, run } = await setup();
        const r = run([...terminal, "worktree", "add", outside]);
        expect(r.argv).toEqual([...terminal, "worktree", "add", outside]);
        expect(r.stderr).toBe("");
      });
    }

    for (const dangling of [["-C"], ["-c"], ["--git-dir"], ["-C", "top"], ["-c", "a.b=1"]]) {
      it(`'git ${dangling.join(" ")}' with no subcommand passes through instead of dying under set -u`, async () => {
        const { run } = await setup();
        const r = run(dangling, tmp);
        expect(r.argv).toEqual(dangling);
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
      });
    }

    it.skipIf(!dockerImagePresent("bash:3.2"))(
      "bash:3.2: 'git -C /top worktree add -b feat ../elsewhere/wt' from / is refused under /top, and an inside path keeps -C (NOT RUN without docker and the bash:3.2 image)",
      async () => {
        const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
        const rec = await globalRecordingGitDir();
        const r = spawnSync("docker", [
          "run", "--rm", "--init", "--network", "none",
          "-v", `${shim}:/s/rig-bin:ro`, "-v", `${rec}:/s/rec:ro`, "bash:3.2",
          "bash", "-c",
          "mkdir -p /top && cd / && export PATH=/s/rig-bin:/s/rec:/usr/local/bin:/usr/bin:/bin; " +
            "timeout -s KILL 5 git -C /top worktree add -b feat ../elsewhere/wt 2>&1; printf 'rc=%s\\n' $?; " +
            // An outside path, so a -c that is not skipped as a value option shows as a missed refusal.
            "timeout -s KILL 5 git -c a.b=1 -C /top worktree add /elsewhere/wt2 2>&1; printf 'rc=%s\\n' $?; " +
            "timeout -s KILL 5 git -C /top worktree add .rig-worktrees/in",
        ], { timeout: 60000 });
        expect(r.status).toBe(0);
        expect(r.stderr.toString()).toBe("");
        const out = r.stdout.toString();
        const relEnd = out.indexOf("rc=128\n") + "rc=128\n".length;
        const withCEnd = out.indexOf("rc=128\n", relEnd) + "rc=128\n".length;
        expect(out.slice(0, relEnd)).toBe(`${refusal("../elsewhere/wt", "/top")}rc=128\n`);
        expect(out.slice(relEnd, withCEnd)).toBe(`${refusal("/elsewhere/wt2", "/top")}rc=128\n`);
        expect(out.slice(withCEnd).split("\0").slice(0, -1)).toEqual(["-C", "/top", "worktree", "add", ".rig-worktrees/in"]);
      },
    );

    it("real git: 'git -C <repo> worktree add -b feat ../outside' from outside the repo is refused under that repo; no branch, no tree", async () => {
      const repo = path.join(tmp, "repo");
      await fs.mkdir(repo);
      const git = path.join(realGitDir(), "git");
      expect(spawnSync(git, ["init", "-q", repo]).status).toBe(0);
      expect(spawnSync(git, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
      await fs.mkdir(path.join(repo, ".git", "info"), { recursive: true }); // the git template may have no info/ (workspaces-o9o.70)
      await fs.appendFile(path.join(repo, ".git", "info", "exclude"), ".rig-worktrees/\n");
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      const r = runGit(["-C", repo, "worktree", "add", "-b", "feat", "../outside-c"], [shim, realGitDir(), "/usr/bin", "/bin"], tmp);
      expect(r.status, r.stderr).toBe(128);
      expect(r.stderr).toBe(refusal("../outside-c", await fs.realpath(repo)));
      expect(spawnSync(git, ["-C", repo, "branch", "--list", "feat"]).stdout.toString(), "no branch feat").toBe("");
      expect(existsSync(path.join(tmp, "outside-c")), "the out-of-place target is not created").toBe(false);
      expect(existsSync(path.join(repo, ".rig-worktrees")), "nor moved into .rig-worktrees").toBe(false);
    });

    // verify-sec, review of 39c68720 (FAIL 1/3): two -C forms escaped .rig-worktrees on real git 2.43.0 and 2.55.0.
    // Each row runs every distinct real git this host has: the first on PATH, and /usr/bin/git.
    const realGits = () => [...new Set([realGitDir(), ...(existsSync("/usr/bin/git") ? ["/usr/bin"] : [])])];
    async function repoAt(dir: string, gitDir: string): Promise<void> {
      const git = path.join(gitDir, "git");
      await fs.mkdir(dir, { recursive: true });
      expect(spawnSync(git, ["init", "-q", dir]).status).toBe(0);
      expect(spawnSync(git, ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
      await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true }); // the git template may have no info/ (workspaces-o9o.70)
      await fs.appendFile(path.join(dir, ".git", "info", "exclude"), ".rig-worktrees/\n");
    }

    it("real git: 'git -C - worktree add' where '-' is a directory: '-' is that directory, never OLDPWD, and the outside path is refused under it", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      for (const [k, gitDir] of realGits().entries()) {
        const work = path.join(tmp, `dash-${k}`);
        const repo = path.join(work, "-");
        await repoAt(repo, gitDir);
        const elsewhere = path.join(tmp, `oldpwd-${k}`);
        await fs.mkdir(elsewhere);
        const r = runGit(["-C", "-", "worktree", "add", "-b", "feat", "../../outside-dash"], [shim, gitDir, "/usr/bin", "/bin"], work, { OLDPWD: elsewhere });
        expect(r.status, `${gitDir}: ${r.stderr}`).toBe(128);
        expect(r.stderr, gitDir).toBe(refusal("../../outside-dash", await fs.realpath(repo)));
        expect(existsSync(path.join(tmp, "outside-dash")), `${gitDir}: the out-of-place target is not created`).toBe(false);
        expect(existsSync(path.join(repo, ".rig-worktrees")), `${gitDir}: nor moved into .rig-worktrees`).toBe(false);
      }
    });

    it("real git: 'git -C <repo whose path ends in a newline> worktree add <outside>': the newline is kept and the path is refused under that repo", async () => {
      const shim = await ensureGitWorktreeShim(tmp, nodeShimFiles);
      for (const [k, gitDir] of realGits().entries()) {
        const repo = path.join(tmp, `nl-${k}`, "repo\n");
        await repoAt(repo, gitDir);
        const r = runGit(["-C", repo, "worktree", "add", "-b", "feat", "../outside-nl"], [shim, gitDir, "/usr/bin", "/bin"], tmp);
        expect(r.status, `${gitDir}: ${r.stderr}`).toBe(128);
        const realRepoDir = await fs.realpath(repo);
        expect(r.stderr, gitDir).toBe(`openrig git shim: refusing worktree path ../outside-nl: seat worktrees go in $'${realRepoDir.slice(0, -1)}\\n/.rig-worktrees'/<name>\n`);
        expect(existsSync(path.join(tmp, `nl-${k}`, "outside-nl")), `${gitDir}: the out-of-place target is not created`).toBe(false);
        expect(existsSync(path.join(repo, ".rig-worktrees")), `${gitDir}: nor moved into .rig-worktrees`).toBe(false);
      }
    });
  });

  it("codex and claude seats both get the shim dir FIRST on PATH", async () => {
    const db: Database.Database = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const fakeOs = mkTemp(path.join(os.tmpdir(), "shim-home-"));
    const openrigHome = path.join(fakeOs, ".openrig");
    await fs.mkdir(openrigHome, { recursive: true });

    const captured: Array<{ name: string; env?: Record<string, string> }> = [];
    const createSession = vi.fn(async (name: string, _c?: string, env?: Record<string, string>) => {
      captured.push({ name, env });
      return { ok: true as const };
    });
    const tmux = {
      createSession,
      killSession: async () => ({ ok: true as const }),
      listSessions: async () => [],
      listWindows: async () => [],
      listPanes: async () => [{ id: "%1" }],
      hasSession: async () => false,
      sendText: async () => ({ ok: true as const }),
      sendKeys: async () => ({ ok: true as const }),
    } as unknown as TmuxAdapter;

    const rig = rigRepo.createRig("shim-path");
    rigRepo.addNode(rig.id, "exec-cos", { role: "coordinator", runtime: "claude-code" });
    rigRepo.addNode(rig.id, "verify-qa", { role: "qa", runtime: "codex" });
    const launcher = new NodeLauncher({
      db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux,
      sessionEnv: { OPENRIG_HOME: openrigHome, PATH: process.env.PATH },
      shimFiles: nodeShimFiles,
    });

    const r1 = await launcher.launchNode(rig.id, "exec-cos");
    expect(r1.ok).toBe(true);
    const r2 = await launcher.launchNode(rig.id, "verify-qa");
    expect(r2.ok).toBe(true);

    for (const c of captured) {
      expect(c.env!.PATH!.startsWith(shimDir(openrigHome) + ":")).toBe(true);
    }
    db.close();
    await fs.rm(fakeOs, { recursive: true, force: true });
  });
});
