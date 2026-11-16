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
function runGit(args: string[], pathDirs: string[], cwd: string) {
  const r = spawnSync("git", args, {
    cwd,
    env: { ...process.env, PATH: pathDirs.join(path.delimiter) },
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
