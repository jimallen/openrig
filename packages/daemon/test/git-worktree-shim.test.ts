import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
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

    const shimDirPath = await ensureGitWorktreeShim(tmp);
    const env = { ...process.env, PATH: shimDirPath + ":" + process.env.PATH };

    // out-of-place target => redirected under <repo>/.rig-worktrees/
    const outside = path.join(tmp, "outside-wt");
    const r1 = spawnSync("git", ["worktree", "add", outside], { cwd: repo, env });
    expect(r1.status).toBe(0);
    const redirected = path.join(repo, ".rig-worktrees", "outside-wt");
    expect((await fs.lstat(redirected)).isDirectory()).toBe(true);

    // in-place target => left alone
    const inside = path.join(repo, ".rig-worktrees", "explicit-wt");
    const r2 = spawnSync("git", ["worktree", "add", inside], { cwd: repo, env });
    expect(r2.status).toBe(0);
    expect((await fs.lstat(inside)).isDirectory()).toBe(true);

    // ordinary git verbs passthrough
    const r3 = spawnSync("git", ["-C", repo, "status", "--porcelain"], { env });
    expect(r3.status).toBe(0);
    // clean repo → empty output is correct; the point is the shim didn't eat the verb
    expect(r3.stdout.toString().trim()).toBe("");
  });

  it("codex and claude seats both get the shim dir FIRST on PATH", async () => {
    const db: Database.Database = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const fakeOs = await fs.mkdtemp(path.join(os.tmpdir(), "shim-home-"));
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
