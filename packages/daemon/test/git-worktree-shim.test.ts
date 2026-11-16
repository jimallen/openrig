import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkTemp } from "./helpers/temp-roots.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { ensureGitWorktreeShim, shimDir, withWorktreeShimPath } from "../src/domain/git-worktree-shim.js";
import { ensureCodexSeatHome } from "../src/domain/codex-seat-home.js";
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
    const dir = await ensureGitWorktreeShim(tmp);
    expect(dir).toBe(path.join(tmp, "rig-bin"));
    const body = await fs.readFile(path.join(dir, "git"), "utf8");
    expect(body).toContain("worktree add");
    expect((await fs.lstat(path.join(dir, "git"))).mode & 0o100).toBeTruthy();
    // second call is a no-op
    await ensureGitWorktreeShim(tmp);
  });

  it("redirects out-of-repo 'git worktree add' into .rig-worktrees, keeps normal add", async () => {
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
    await fs.appendFile(path.join(repo, ".git", "info", "exclude"), ".rig-worktrees/\n");

    const shimDirPath = await ensureGitWorktreeShim(tmp);
    const pathDirs = [shimDirPath, realGitDir(), "/usr/bin", "/bin"];

    // out-of-place target => redirected under <repo>/.rig-worktrees/
    const outside = path.join(tmp, "outside-wt");
    const r1 = runGit(["worktree", "add", outside], pathDirs, repo);
    expect(r1.status).toBe(0);
    const redirected = path.join(repo, ".rig-worktrees", "outside-wt");
    expect((await fs.lstat(redirected)).isDirectory()).toBe(true);
    expect(existsSync(outside), "the out-of-place target is not created").toBe(false);
    // git's own progress lines are the only stderr: nothing from the shim
    expect(r1.stderr).not.toMatch(/invalid option|unbound variable|openrig shim/);

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

  // workspaces-o9o.2: the generated file run under real bash. At d0303ca8 real_git ran 'command -v -a git'
  // (zsh syntax; bash's 'command' has no -a), built self with literal quotes, and fell back to /usr/bin/git
  // or to 'command -v git', which is the shim itself.
  describe("real_git: the first git on PATH that is not this shim", () => {
    it("an ordinary git call prints no 'command: -a: invalid option' and runs the next git on PATH", async () => {
      const shim = await ensureGitWorktreeShim(tmp);
      const r = runGit(["--version"], [shim, await prefGitDir(), "/usr/bin", "/bin"], tmp);
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe("PREF --version\n");
      expect(r.status).toBe(0);
    });

    it("skips the shim when it is reached again through a symlinked directory earlier on PATH (no exec loop)", async () => {
      const shim = await ensureGitWorktreeShim(tmp);
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
        const shim = await ensureGitWorktreeShim(tmp);
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
      const shim = await ensureGitWorktreeShim(tmp);
      const r = runGit(["--version"], [shim, await toolsDir("bash", "dirname")], tmp);
      expect(r.signal, "the shim did not exec itself until the timeout").toBeNull();
      expect(r.status).toBe(127);
      expect(r.stdout, "no git outside PATH (such as /usr/bin/git) ran").toBe("");
      expect(r.stderr).toContain("git: command not found");
    });

    it("'git worktree' with no further argument passes through instead of dying on $2 under set -u", async () => {
      const shim = await ensureGitWorktreeShim(tmp);
      const r = runGit(["worktree"], [shim, await prefGitDir(), "/usr/bin", "/bin"], tmp);
      expect(r.stderr).toBe("");
      expect(r.stdout).toBe("PREF worktree\n");
      expect(r.status).toBe(0);
    });

    it("'git worktree add' with no path passes through instead of dying on args[0] under set -u", async () => {
      const shim = await ensureGitWorktreeShim(tmp);
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
          const shim = await ensureGitWorktreeShim(tmp);
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
            const shim = await ensureGitWorktreeShim(tmp);
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

  // workspaces-o9o.5: when the redirect fires, git must receive the caller's argv with only the path word
  // rewritten. At 6a6c796e the shim rebuilt the call from the positional words alone, so -b/-B and every
  // flag were dropped; it also parsed --track and --guess-remote as taking a value (git 2.43.0's
  // `git worktree add -h` lists both as booleans), and rewrote an inside path given relative.
  describe("worktree add redirect: only the path word changes", () => {
    const NOT_CHECKED = "openrig git shim: worktree path not checked (unrecognised option ";

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
      const shim = await ensureGitWorktreeShim(tmp);
      const top = path.join(tmp, "top");
      await fs.mkdir(top, { recursive: true });
      const realTop = await fs.realpath(top);
      const outside = path.join(tmp, "elsewhere", "wt");
      const redirected = path.join(realTop, ".rig-worktrees", "wt");
      const pathDirs = [shim, await recordingGitDir(), "/usr/bin", "/bin"];
      const run = (args: string[]) => {
        const r = runGit(["worktree", "add", ...args], pathDirs, top);
        return { ...r, argv: r.stdout.split("\0").slice(0, -1) };
      };
      return { top, realTop, outside, redirected, run };
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
      it(`'${form.join(" ")}' before an outside path: every word reaches git, only the path is rewritten`, async () => {
        const { outside, redirected, run } = await setup();
        const r = run([...form, outside]);
        expect(r.argv).toEqual(["worktree", "add", ...form, redirected]);
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
      });
    }

    it("keeps the commit-ish and options after the path, in order", async () => {
      const { outside, redirected, run } = await setup();
      const r = run(["-b", "feat", outside, "HEAD~0", "--quiet"]);
      expect(r.argv).toEqual(["worktree", "add", "-b", "feat", redirected, "HEAD~0", "--quiet"]);
      expect(r.stderr).toBe("");
    });

    it("after '--' the next word is the path, even when it starts with a dash", async () => {
      const { realTop, run } = await setup();
      const r = run(["-b", "feat", "--", "-wt"]);
      expect(r.argv).toEqual(["worktree", "add", "-b", "feat", "--", path.join(realTop, ".rig-worktrees", "-wt")]);
      expect(r.stderr).toBe("");
    });

    for (const unknown of [["--det"], ["-fq"], ["--lock", "--rea", "x"], ["--some-future-option"]]) {
      it(`an option the shim does not know ('${unknown.join(" ")}') passes through unredirected, with one stderr line`, async () => {
        const { outside, run } = await setup();
        const r = run([...unknown, outside]);
        expect(r.argv).toEqual(["worktree", "add", ...unknown, outside]);
        const word = unknown.find(w => w.startsWith("-") && !["--lock"].includes(w));
        expect(r.stderr).toBe(`${NOT_CHECKED}${word})\n`);
        expect(r.status).toBe(0);
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
      const shim = await ensureGitWorktreeShim(tmp);
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
      "bash:3.2: a relative './' inside path is unchanged and '-b feat <outside>' keeps -b (NOT RUN without docker and the bash:3.2 image)",
      async () => {
        const shim = await ensureGitWorktreeShim(tmp);
        const rec = await recordingGitDir();
        const r = spawnSync("docker", [
          "run", "--rm", "--init", "--network", "none",
          "-v", `${shim}:/s/rig-bin:ro`, "-v", `${rec}:/s/rec:ro`, "bash:3.2",
          "bash", "-c",
          "mkdir -p /top && cd /top && export PATH=/s/rig-bin:/s/rec:/usr/local/bin:/usr/bin:/bin; " +
            "timeout -s KILL 5 git worktree add -b feat ./.rig-worktrees/in; printf '\\n'; " +
            "timeout -s KILL 5 git worktree add -b feat /elsewhere/wt",
        ], { timeout: 60000 });
        expect(r.status).toBe(0);
        expect(r.stderr.toString()).toBe("");
        const [inside, outside] = r.stdout.toString().split("\n").map(line => line.split("\0").slice(0, -1));
        expect(inside).toEqual(["worktree", "add", "-b", "feat", "./.rig-worktrees/in"]);
        expect(outside).toEqual(["worktree", "add", "-b", "feat", "/top/.rig-worktrees/wt"]);
      },
    );

    it("real git: 'worktree add -b feat <outside>' creates branch feat, checked out in the redirected worktree", async () => {
      const repo = path.join(tmp, "repo");
      await fs.mkdir(repo);
      const git = path.join(realGitDir(), "git");
      expect(spawnSync(git, ["init", "-q", repo]).status).toBe(0);
      expect(spawnSync(git, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
      await fs.appendFile(path.join(repo, ".git", "info", "exclude"), ".rig-worktrees/\n");
      const shim = await ensureGitWorktreeShim(tmp);
      const r = runGit(["worktree", "add", "-b", "feat", path.join(tmp, "outside-b")], [shim, realGitDir(), "/usr/bin", "/bin"], repo);
      expect(r.status, r.stderr).toBe(0);
      const wt = path.join(repo, ".rig-worktrees", "outside-b");
      const branch = spawnSync(git, ["-C", wt, "branch", "--show-current"]).stdout.toString().trim();
      expect(branch).toBe("feat");
      expect(existsSync(path.join(tmp, "outside-b"))).toBe(false);
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
      await fs.appendFile(path.join(repo, ".git", "info", "exclude"), ".rig-worktrees/\n");
      const realRepoDir = await fs.realpath(repo);
      await fs.mkdir(path.join(realRepoDir, ".rig-worktrees"));
      const portalTarget = path.join(tmp, "portal-target");
      await fs.mkdir(portalTarget);
      await fs.symlink(portalTarget, path.join(realRepoDir, ".rig-worktrees", "portal"));
      const shim = await ensureGitWorktreeShim(tmp);
      const run = (args: string[]) => runGit(["worktree", "add", ...args], [shim, realGitDir(), "/usr/bin", "/bin"], realRepoDir);
      return { repo: realRepoDir, git, portalTarget, run };
    }

    for (const form of ["relative", "absolute"] as const) {
      it(`real git, ${form}: '.rig-worktrees/../escaped-wt' does not escape; it lands in .rig-worktrees`, async () => {
        const { repo, run } = await realRepo();
        const target = form === "relative" ? "./.rig-worktrees/../escaped-wt" : `${repo}/.rig-worktrees/../escaped-wt`; // not path.join, which would fold the ".." away
        const r = run(["-b", "escaped", target]);
        expect(r.status, r.stderr).toBe(0);
        expect(existsSync(path.join(repo, "escaped-wt")), "nothing is created beside .rig-worktrees").toBe(false);
        expect(existsSync(path.join(repo, ".rig-worktrees", "escaped-wt", ".git"))).toBe(true);
      });

      it(`real git, ${form}: a symlink inside .rig-worktrees to an outside dir is not a way out`, async () => {
        const { repo, portalTarget, run } = await realRepo();
        const target = form === "relative" ? "./.rig-worktrees/portal/escaped-symlink" : path.join(repo, ".rig-worktrees", "portal", "escaped-symlink");
        const r = run(["-b", "escaped", target]);
        expect(r.status, r.stderr).toBe(0);
        expect(existsSync(path.join(portalTarget, "escaped-symlink")), "nothing is created in the symlink's target").toBe(false);
        expect(existsSync(path.join(repo, ".rig-worktrees", "escaped-symlink", ".git"))).toBe(true);
      });
    }

    // verify-sec, review of cc9a1496 (FAIL 2/3): the leaf was checked for a symlink but not .rig-worktrees itself, so
    // with the ROOT a symlink to an outside dir, mkdir -p and git both followed it and the worktree landed outside.
    it("real git: when .rig-worktrees itself is a symlink to an outside dir, the redirect is refused and nothing lands there", async () => {
      const repo = path.join(tmp, "rootlink");
      await fs.mkdir(repo);
      const git = path.join(realGitDir(), "git");
      expect(spawnSync(git, ["init", "-q", repo]).status).toBe(0);
      expect(spawnSync(git, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
      const outside = path.join(tmp, "root-target");
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(repo, ".rig-worktrees"));
      const shim = await ensureGitWorktreeShim(tmp);
      const r = runGit(["worktree", "add", "-b", "escape", path.join(tmp, "outside2", "asked")], [shim, realGitDir(), "/usr/bin", "/bin"], repo);
      expect(r.status).toBe(128);
      expect(r.stderr).toMatch(/^openrig git shim: refusing worktree path [^\n]*\n$/);
      expect(await fs.readdir(outside), "nothing is created through the symlinked root").toEqual([]);
      expect(existsSync(path.join(tmp, "outside2")), "nor at the path asked for").toBe(false);
    });

    it("when .rig-worktrees exists but is not a directory, the redirect is refused before mkdir or git runs", async () => {
      const { realTop, outside, run } = await setup();
      await fs.writeFile(path.join(realTop, ".rig-worktrees"), "not a dir\n");
      const r = run(["-b", "feat", outside]);
      expect(r.status).toBe(128);
      expect(r.argv, "git did not run").toEqual([]);
      expect(r.stderr).toMatch(/^openrig git shim: refusing worktree path [^\n]*\n$/);
    });

    it("real git: the portal itself as the path ('.rig-worktrees/portal', a symlink to an empty outside dir) is refused, not redirected onto itself", async () => {
      const { portalTarget, run } = await realRepo();
      const r = run(["-b", "escaped", ".rig-worktrees/portal"]);
      expect(r.status).toBe(128);
      expect(r.stderr).toMatch(/^openrig git shim: refusing worktree path [^\n]*\n$/);
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

    it("a '..' in the part of the path that does not exist yet counts as outside: redirected by its last name", async () => {
      const { realTop, run } = await setup();
      const r = run(["-b", "feat", ".rig-worktrees/not-yet/../wt2"]);
      expect(r.argv).toEqual(["worktree", "add", "-b", "feat", path.join(realTop, ".rig-worktrees", "wt2")]);
      expect(r.stderr).toBe("");
    });

    it("a trailing slash on an outside path redirects by the last name, as basename does", async () => {
      const { outside, redirected, run } = await setup();
      const r = run(["-b", "feat", outside + "/"]);
      expect(r.argv).toEqual(["worktree", "add", "-b", "feat", redirected]);
      expect(r.stderr).toBe("");
    });

    // A redirect named '', '.' or '..' would not be a dir inside .rig-worktrees: '.' made .rig-worktrees itself the
    // worktree (measured at 6dc59b2b: `git worktree add -b dot <outside>/.` on a repo with no .rig-worktrees yet),
    // and '..' named the repo. Refused before git runs.
    for (const target of ["..", "../..", "/", "/elsewhere/.", ".", "/bad\u001b[31m\nname/."]) {
      it(`an outside path with no name to redirect to (${JSON.stringify(target)}) is refused: exit 128, one quoted stderr line, git not run`, async () => {
        const { run } = await setup();
        const r = run(["-b", "feat", target]);
        expect(r.status).toBe(128);
        expect(r.argv, "git did not run").toEqual([]);
        expect(r.stderr).toMatch(/^openrig git shim: refusing worktree path [^\n]*\n$/);
        expect(/[\u0000-\u001f\u007f]/.test(r.stderr.slice(0, -1)), JSON.stringify(r.stderr)).toBe(false);
      });
    }

    it("a real dir named '.rig-worktrees<newline>' is not .rig-worktrees: a path through it is redirected", async () => {
      const { top, realTop, run } = await setup();
      await fs.mkdir(path.join(top, ".rig-worktrees\n"));
      const r = run(["-b", "feat", ".rig-worktrees\n/wt"]);
      expect(r.argv).toEqual(["worktree", "add", "-b", "feat", path.join(realTop, ".rig-worktrees", "wt")]);
      expect(r.stderr).toBe("");
    });

    // The physical-path check, the refusal, the newline and the quoted diagnostic under the macOS bash version.
    it.skipIf(!dockerImagePresent("bash:3.2"))(
      "bash:3.2: '..' and a symlink portal are redirected, '.' is refused, a trailing newline is kept, the diagnostic is one line (NOT RUN without docker and the bash:3.2 image)",
      async () => {
        const shim = await ensureGitWorktreeShim(tmp);
        const rec = await recordingGitDir();
        const r = spawnSync("docker", [
          "run", "--rm", "--init", "--network", "none",
          "-v", `${shim}:/s/rig-bin:ro`, "-v", `${rec}:/s/rec:ro`, "bash:3.2",
          "bash", "-c",
          "mkdir -p /top/.rig-worktrees /out && ln -s /out /top/.rig-worktrees/portal && cd /top && " +
            "export PATH=/s/rig-bin:/s/rec:/usr/local/bin:/usr/bin:/bin; " +
            "timeout -s KILL 5 git worktree add -b f ./.rig-worktrees/../esc; printf '\\036'; " +
            "timeout -s KILL 5 git worktree add -b f ./.rig-worktrees/portal/x; printf '\\036'; " +
            "timeout -s KILL 5 git worktree add -b f $'/elsewhere/wt\\n'; printf '\\036'; " +
            "timeout -s KILL 5 git worktree add -b f /elsewhere/. 2>/dev/null; printf 'rc=%s\\036' $?; " +
            "timeout -s KILL 5 git worktree add $'--x\\033[31m\\nforged' /elsewhere/wt 2>&1 >/dev/null",
        ], { timeout: 60000 });
        expect(r.status).toBe(0);
        const [dotdot, portal, newline, refused, diag] = r.stdout.toString().split("\u001e");
        const argv = (s: string | undefined) => (s ?? "").split("\0").slice(0, -1);
        expect(argv(dotdot)).toEqual(["worktree", "add", "-b", "f", "/top/.rig-worktrees/esc"]);
        expect(argv(portal)).toEqual(["worktree", "add", "-b", "f", "/top/.rig-worktrees/x"]);
        expect(argv(newline)).toEqual(["worktree", "add", "-b", "f", "/top/.rig-worktrees/wt\n"]);
        expect(refused).toBe("rc=128");
        expect(diag?.startsWith(NOT_CHECKED)).toBe(true);
        expect(/[\u0000-\u001f\u007f]/.test((diag ?? "").slice(0, -1)), JSON.stringify(diag)).toBe(false);
        expect(r.stderr.toString()).toBe("");
      },
    );

    it("real git: 'worktree add -b dot <outside>/.' does not make .rig-worktrees itself a worktree", async () => {
      const repo = path.join(tmp, "fresh");
      await fs.mkdir(repo);
      const git = path.join(realGitDir(), "git");
      expect(spawnSync(git, ["init", "-q", repo]).status).toBe(0);
      expect(spawnSync(git, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "init"]).status).toBe(0);
      const other = path.join(tmp, "other");
      await fs.mkdir(other);
      const shim = await ensureGitWorktreeShim(tmp);
      const r = runGit(["worktree", "add", "-b", "dot", other + "/."], [shim, realGitDir(), "/usr/bin", "/bin"], repo);
      expect(r.status).toBe(128);
      const list = spawnSync(git, ["-C", repo, "worktree", "list", "--porcelain"]).stdout.toString();
      expect(list.match(/^worktree /gm)?.length, list).toBe(1);
    });

    // verify-sec finding 2: $(basename ...) dropped a trailing newline from the path word.
    it("a path word ending in a newline keeps it when redirected, and an inside one is unchanged", async () => {
      const { realTop, run } = await setup();
      const r = run(["-b", "feat", path.join(tmp, "elsewhere", "wt\n")]);
      expect(r.argv).toEqual(["worktree", "add", "-b", "feat", path.join(realTop, ".rig-worktrees", "wt\n")]);
      const r2 = run(["-b", "feat", ".rig-worktrees/in\n"]);
      expect(r2.argv).toEqual(["worktree", "add", "-b", "feat", ".rig-worktrees/in\n"]);
      expect(r.stderr + r2.stderr).toBe("");
    });

    // verify-sec finding 3: the unknown word went raw into the diagnostic, so a newline split it and an escape
    // sequence reached the terminal.
    for (const word of ["--x\nforged line", "--\u001b[31mred", "--bell\u0007"]) {
      it(`an unknown option with control characters (${JSON.stringify(word)}) is quoted in a one-line diagnostic`, async () => {
        const { outside, run } = await setup();
        const r = run([word, outside]);
        expect(r.argv).toEqual(["worktree", "add", word, outside]);
        expect(r.stderr.startsWith(NOT_CHECKED)).toBe(true);
        expect(r.stderr.endsWith(")\n")).toBe(true);
        // No control character but the final newline.
        expect(/[\u0000-\u001f\u007f]/.test(r.stderr.slice(0, -1)), JSON.stringify(r.stderr)).toBe(false);
      });
    }
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
