// workspaces-o9o.3, on a real tmux server (a private socket directory, never the operator's; the session's TMUX is not
// passed on): on Sparky an oh-my-zsh "update? [Y/n]" prompt swallowed a seat's launch command and OpenRig reported only
// "Readiness timeout after 30s". Here a controlled script stands in for that shell: it prints the prompt, reads one line
// (the launch command typed into the pane becomes its answer) and then waits. The surfaced error must quote it.
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const HAS_TMUX = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe.skipIf(!HAS_TMUX || process.platform === "win32")("a launch swallowed by a shell prompt names the prompt in its error (real tmux)", () => {
  let base: string;
  let env: NodeJS.ProcessEnv;
  let tmuxAdapter: TmuxAdapter;
  let db: Database.Database;
  const tmux = (...args: string[]) => execFileSync("tmux", args, { env, encoding: "utf8" });
  const SESSION = "build-impl@o9o3";

  beforeAll(() => {
    // A short socket directory under /tmp (a unix socket path is bounded), and an environment built from scratch: no TMUX,
    // no TMUX_PANE, HOME pointed at the scratch dir so no rc file of the operator's runs.
    base = realpathSync(mkdtempSync("/tmp/o9o3-"));
    env = { PATH: process.env.PATH, HOME: base, TMUX_TMPDIR: base, TERM: "xterm-256color", SHELL: "/bin/sh" };
    tmuxAdapter = new TmuxAdapter((cmd) => new Promise((resolve, reject) => {
      execFile("/bin/sh", ["-c", cmd], { env, encoding: "utf8" }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)));
    }));
    db = createFullTestDb();
  });
  afterAll(() => {
    try { db.close(); } finally {
      try { tmux("kill-server"); } catch { /* already gone */ }
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("the readiness-timeout error quotes the prompt that ate the launch command", async () => {
    const script = join(base, "swallow.sh");
    writeFileSync(script, "printf '[oh-my-zsh] Would you like to update? [Y/n] '\nread answer\nexec sleep 600\n");
    tmux("new-session", "-d", "-s", SESSION, "-x", "200", "-y", "20", `/bin/sh ${script}`);
    for (let i = 0; i < 100 && !tmux("capture-pane", "-p", "-t", `=${SESSION}:`).includes("[Y/n]"); i++) await new Promise((r) => setTimeout(r, 50));

    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("o9o3-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, SESSION);
    sessionRegistry.updateStatus(session.id, "running");

    // The launch types its command the way a runtime adapter does; the prompt's `read` takes it as the answer.
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => { tmux("send-keys", "-t", `=${SESSION}:`, "-l", "claude --permission-mode auto"); tmux("send-keys", "-t", `=${SESSION}:`, "Enter"); return { ok: true as const }; },
      checkReady: async () => ({ ready: false, reason: "harness not interactive" }),
    };
    const orch = new StartupOrchestrator({
      db, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter,
      sleep: async () => {}, listProcesses: async () => [],
    });
    const result = await orch.startNode({
      rigId: rig.id, nodeId: node.id, sessionId: session.id,
      binding: { id: "b1", nodeId: node.id, tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null, updatedAt: "", cwd: base },
      adapter, plan: { runtime: "claude-code", cwd: base, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] }, resolvedStartupFiles: [], startupActions: [], isRestore: false,
      readinessTimeoutMs: 1500,
    });

    if (result.ok) throw new Error("expected a readiness failure");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Readiness timeout after 1.5s");
    expect(result.errors[0]).toContain("[oh-my-zsh] Would you like to update? [Y/n] claude --permission-mode auto");
  });
});
